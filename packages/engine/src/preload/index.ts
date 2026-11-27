// Loaded into every process of `eve dev` through NODE_OPTIONS=--import. It answers each non-loopback HTTP request
// with the fake provider, appends the request to the run's ledger, persists the provider state and, at the
// chosen crash point, SIGKILLs its own process so the engine can watch what eve does on resume. File writes of
// node:fs inside the lab are effects too: they go through the same ledger, state and crash point.
//
// Environment (inactive unless CT_RUN_DIR is set):
//   CT_RUN_DIR          directory holding preload.ready, ledger.jsonl, provider-state.json and crashed.marker
//   CT_CRASH_POINT      none | post-effect-fast | post-effect-slow | post-settle (the last is the engine's business)
//   CT_FAKE_LATENCY_MS  delay before every faked response (default 0)
//   CT_SLOW_HOLD_MS     how long post-effect-slow waits before the kill (default 2000)
//   CT_FIXTURES         optional path of a JSON file with an array of fixtures
//   CT_LAB_DIR          the lab; when set, node:fs writes inside it are recorded as effects (see fs-effects.ts)
//   CT_EFFECTS_IGNORE   optional JSON array of the config's `effects.ignore` globs: a request or file write they match
//                       is still recorded, but never claims the crash point
//
// Runs inside the agent's own process: Node built-ins and the interceptor only, and no output of its own.
import fs, { mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import type { LedgerEntry } from "../types.ts";
import { ignoreMatcher } from "./effects-ignore.ts";
import { createFakeProvider, type FakeEffect, type FakeResult, type Fixture, type ProviderState } from "./fake-provider.ts";
import { installFsEffects } from "./fs-effects.ts";
import { isRecord, redactUrl } from "./normalize.ts";

// Installing the file-system effects patches node:fs and refreshes the live bindings of every named import, this
// module's too. The write function the preload itself uses is taken here, before any patching, and every file of
// its own (ledger, ready file, state, marker) is written with it, so none of those writes reaches a wrapped
// function. That includes appends, which are `writeFileSync` with the append flag: the original `appendFileSync`
// would call the patched `fs.writeFileSync`. The path filter of the wrappers is a second line, not the first.
const { writeFileSync } = fs;

/** Appends `text` to `file` without going through a wrapped function. */
function appendText(file: string, text: string): void {
  writeFileSync(file, text, { flag: "a" });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
// A Response with one of these statuses must not carry a body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** A file write is recorded with at most this much of its content (the comparison of repeated writes sees all of it). */
const FS_BODY_CHARS = 2048;
/** How long a process waits for its own SIGKILL to arrive before it reports that the kill did not work. */
const DEATH_WAIT_MS = 10_000;

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** The already redacted body of a file write, cut at 2 KB: text as it is, JSON as its first characters. */
function clip(body: unknown): unknown {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > FS_BODY_CHARS ? text.slice(0, FS_BODY_CHARS) : body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A short blocking pause: the state is read and written in a section that must not yield to other requests. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RETRY_DELAY_MS = 25;
const RENAME_ATTEMPTS = 5;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Reads and parses a file of the run directory. Only a missing file means "nothing yet" (null): a read or parse
 * failure is retried once and then thrown, so a damaged file makes the request fail instead of being taken for an
 * empty history that the next write would then overwrite.
 */
function readRunFile<T>(file: string, parse: (text: string) => T): T | null {
  for (let attempt = 1; ; attempt++) {
    try {
      return parse(readFileSync(file, "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      if (attempt >= 2) throw new Error(`crashtest preload: ${file} is unreadable: ${(error as Error).message}`, { cause: error });
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

function parseState(text: string): ProviderState {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new TypeError("not a JSON object");
  return parsed as unknown as ProviderState;
}

function countLines(text: string): number {
  return text.split("\n").filter(Boolean).length;
}

/** Temp file in the same directory, then rename: a reader sees the old state or the new one, never half of it. */
function writeAtomically(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text);
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, file);
      return;
    } catch (error) {
      // Windows refuses to replace a file another process has open for a moment.
      const transient = errorCode(error) === "EPERM" || errorCode(error) === "EBUSY";
      if (!transient || attempt >= RENAME_ATTEMPTS) {
        rmSync(temp, { force: true });
        throw error;
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
}

function loadFixtures(file: string | undefined): Fixture[] {
  if (file === undefined || file === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`crashtest preload: cannot read CT_FIXTURES ${file}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`crashtest preload: CT_FIXTURES ${file} must be a JSON array of fixtures`);
  return parsed as Fixture[];
}

/** The matcher of CT_EFFECTS_IGNORE (nothing is ignored without it). Anything but a JSON array of strings is an error. */
function loadIgnore(raw: string | undefined): (url: string) => boolean {
  if (raw === undefined || raw === "") return () => false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`crashtest preload: CT_EFFECTS_IGNORE is not JSON: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || !parsed.every((glob) => typeof glob === "string")) {
    throw new Error("crashtest preload: CT_EFFECTS_IGNORE must be a JSON array of strings");
  }
  return ignoreMatcher(parsed);
}

function activate(runDir: string): void {
  const ledgerFile = join(runDir, "ledger.jsonl");
  const stateFile = join(runDir, "provider-state.json");
  const markerFile = join(runDir, "crashed.marker");
  const crashPoint = process.env.CT_CRASH_POINT ?? "none";
  const latencyMs = numberFromEnv("CT_FAKE_LATENCY_MS", 0);
  const holdMs = numberFromEnv("CT_SLOW_HOLD_MS", 2000);
  const fixtures = loadFixtures(process.env.CT_FIXTURES);
  const ignored = loadIgnore(process.env.CT_EFFECTS_IGNORE);

  mkdirSync(runDir, { recursive: true });
  appendText(join(runDir, "preload.ready"), `${process.pid}\n`);

  // The state and the ledger are read again for every request: eve runs more than one preloaded process against
  // the same run directory, and a process that restarts after a crash must continue where the last one died.
  const loadState = (): ProviderState | null => readRunFile(stateFile, parseState);
  const nextSeq = (): number => (readRunFile(ledgerFile, countLines) ?? 0) + 1;

  function appendEntry(what: Pick<LedgerEntry, "kind" | "method" | "url" | "body" | "status">, effect: FakeEffect): void {
    const entry: LedgerEntry = {
      seq: nextSeq(),
      ts: new Date().toISOString(),
      pid: process.pid,
      kind: what.kind,
      method: what.method,
      url: what.url,
      endpoint: effect.endpoint,
      ...(effect.object === undefined ? {} : { object: effect.object }),
      mutating: effect.mutating,
      stateChange: effect.stateChange,
      ...(effect.benign === undefined ? {} : { benign: effect.benign }),
      ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
      body: what.body,
      status: what.status,
    };
    appendText(ledgerFile, `${JSON.stringify(entry)}\n`);
  }

  /** `ledgerUrl` is the redacted URL. */
  function record(method: string, ledgerUrl: string, result: FakeResult): void {
    appendEntry({ kind: "http", method: method.toUpperCase(), url: ledgerUrl, body: result.effect.body, status: result.status }, result.effect);
  }

  /** True for exactly one process of the run: the one that creates the marker. */
  function claimCrash(): boolean {
    try {
      writeFileSync(markerFile, `${crashPoint} pid=${process.pid}`, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  /**
   * The crash point's rule for any effect, HTTP or file: one that may have changed something, once per run. An effect
   * whose ledger url `effects.ignore` matches (with the matcher detection counts with) is not the tool's and never
   * claims it.
   */
  function crashesAfter(effect: FakeEffect, ledgerUrl: string): boolean {
    return effect.mutating && !ignored(ledgerUrl) && (crashPoint === "post-effect-fast" || crashPoint === "post-effect-slow") && claimCrash();
  }

  /**
   * A file write of the tool that has already happened: the effect goes to the ledger and the state, then the crash
   * point applies. The caller of a write cannot wait, so the hold of post-effect-slow blocks the whole process.
   */
  function recordFileWrite(op: "WRITE" | "APPEND", relPath: string, content: string): void {
    const provider = createFakeProvider(loadState(), fixtures);
    const effect = provider.fsWrite(op, relPath, content);
    appendEntry({ kind: "fs", method: op, url: relPath, body: clip(effect.body), status: 0 }, effect);
    writeAtomically(stateFile, JSON.stringify(provider.state));

    if (!crashesAfter(effect, relPath)) return;
    if (crashPoint === "post-effect-slow") sleepSync(holdMs);
    process.kill(process.pid, "SIGKILL");
    sleepSync(DEATH_WAIT_MS); // the kill is asynchronous on some platforms: never go on from a dying process
    throw new Error("crashtest preload: the process survived its own SIGKILL");
  }

  const interceptor = new HttpRequestInterceptor();
  interceptor.on("request", async ({ request, controller }) => {
    const url = new URL(request.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return; // not answered here: the request goes on to the real socket

    const bodyText = await request.clone().text();
    // Everything between here and the first await below is synchronous, so two requests of one process
    // can never interleave their read-modify-write of the state and the ledger.
    const provider = createFakeProvider(loadState(), fixtures);
    const result = provider.handle({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), bodyText });
    const ledgerUrl = redactUrl(request.url);
    record(request.method, ledgerUrl, result);
    writeAtomically(stateFile, JSON.stringify(provider.state));

    if (crashesAfter(result.effect, ledgerUrl)) {
      if (crashPoint === "post-effect-slow") await sleep(holdMs);
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => {}); // the kill is asynchronous on some platforms: never answer from a dying process
    }

    if (latencyMs > 0) await sleep(latencyMs);
    const body = NULL_BODY_STATUSES.has(result.status) ? null : JSON.stringify(result.body);
    controller.respondWith(new Response(body, { status: result.status, headers: result.headers }));
  });
  interceptor.apply();

  const labDir = process.env.CT_LAB_DIR;
  if (labDir) installFsEffects({ labDir, runDir, record: recordFileWrite });
}

const runDir = process.env.CT_RUN_DIR;
if (runDir) activate(runDir);
