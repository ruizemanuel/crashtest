// Loaded into every process of `eve dev` through NODE_OPTIONS=--import. It answers each non-loopback HTTP request
// with the fake provider, appends the request to the run's ledger, persists the provider state and, at the
// chosen crash point, SIGKILLs its own process so the engine can watch what eve does on resume.
//
// Environment (inactive unless CT_RUN_DIR is set):
//   CT_RUN_DIR          directory holding preload.ready, ledger.jsonl, provider-state.json and crashed.marker
//   CT_CRASH_POINT      none | post-effect-fast | post-effect-slow | post-settle (the last is the engine's business)
//   CT_FAKE_LATENCY_MS  delay before every faked response (default 0)
//   CT_SLOW_HOLD_MS     how long post-effect-slow waits before the kill (default 2000)
//   CT_FIXTURES         optional path of a JSON file with an array of fixtures
//   CT_LAB_DIR          reserved for the filesystem effect watcher; not read here
//
// Runs inside the agent's own process: Node built-ins and the interceptor only, and no output of its own.
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";
import type { LedgerEntry } from "../types.ts";
import { createFakeProvider, type FakeResult, type Fixture, type ProviderState } from "./fake-provider.ts";
import { isRecord, redactUrl } from "./normalize.ts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
// A Response with one of these statuses must not carry a body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
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

function activate(runDir: string): void {
  const ledgerFile = join(runDir, "ledger.jsonl");
  const stateFile = join(runDir, "provider-state.json");
  const markerFile = join(runDir, "crashed.marker");
  const crashPoint = process.env.CT_CRASH_POINT ?? "none";
  const latencyMs = numberFromEnv("CT_FAKE_LATENCY_MS", 0);
  const holdMs = numberFromEnv("CT_SLOW_HOLD_MS", 2000);
  const fixtures = loadFixtures(process.env.CT_FIXTURES);

  mkdirSync(runDir, { recursive: true });
  appendFileSync(join(runDir, "preload.ready"), `${process.pid}\n`);

  // The state and the ledger are read again for every request: eve runs more than one preloaded process against
  // the same run directory, and a process that restarts after a crash must continue where the last one died.
  const loadState = (): ProviderState | null => readRunFile(stateFile, parseState);
  const nextSeq = (): number => (readRunFile(ledgerFile, countLines) ?? 0) + 1;

  function record(method: string, url: string, result: FakeResult): void {
    const { effect } = result;
    const entry: LedgerEntry = {
      seq: nextSeq(),
      ts: new Date().toISOString(),
      pid: process.pid,
      kind: "http",
      method: method.toUpperCase(),
      url: redactUrl(url),
      endpoint: effect.endpoint,
      mutating: effect.mutating,
      stateChange: effect.stateChange,
      ...(effect.benign === undefined ? {} : { benign: effect.benign }),
      ...(effect.idempotencyKey === undefined ? {} : { idempotencyKey: effect.idempotencyKey }),
      body: effect.body,
      status: result.status,
    };
    appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
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

  const interceptor = new HttpRequestInterceptor();
  interceptor.on("request", async ({ request, controller }) => {
    const url = new URL(request.url);
    if (LOOPBACK_HOSTS.has(url.hostname)) return; // not answered here: the request goes on to the real socket

    const bodyText = await request.clone().text();
    // Everything between here and the first await below is synchronous, so two requests of one process
    // can never interleave their read-modify-write of the state and the ledger.
    const provider = createFakeProvider(loadState(), fixtures);
    const result = provider.handle({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers), bodyText });
    record(request.method, request.url, result);
    writeAtomically(stateFile, JSON.stringify(provider.state));

    if (result.effect.mutating && (crashPoint === "post-effect-fast" || crashPoint === "post-effect-slow") && claimCrash()) {
      if (crashPoint === "post-effect-slow") await sleep(holdMs);
      process.kill(process.pid, "SIGKILL");
      await new Promise<never>(() => {}); // the kill is asynchronous on some platforms: never answer from a dying process
    }

    if (latencyMs > 0) await sleep(latencyMs);
    const body = NULL_BODY_STATUSES.has(result.status) ? null : JSON.stringify(result.body);
    controller.respondWith(new Response(body, { status: result.status, headers: result.headers }));
  });
  interceptor.apply();
}

const runDir = process.env.CT_RUN_DIR;
if (runDir) activate(runDir);
