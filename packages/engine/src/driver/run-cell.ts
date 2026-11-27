// Runs one cell: one `eve dev` life in the lab with one crash point. The preload (or the probe hook) SIGKILLs
// the server at the crash point; the runner notices, restarts it once with `--resume`, approves whatever the
// turn asks for, waits for the turn to settle and returns a summary that names everything it was run with.
// Target failures never throw: they end up in `turnOutcome` and `error`.
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionAuthFor, type CrashtestConfig } from "../config.ts";
import { preloadedLabEnv, type Lab } from "../lab.ts";
import type { Cell, CellId, LedgerEntry, RunSummary, ToolInfo } from "../types.ts";
import { HealthMonitor } from "./health.ts";
import { restoreLabFiles, writtenPaths } from "./lab-files.ts";
import { freePort, killPort, listenerPids } from "./ports.ts";
import { killTree, spawnTracked } from "./process.ts";
import { parseStream, type ParsedStream } from "./stream.ts";

export interface RunCellOptions {
  lab: Lab;
  tool: ToolInfo;
  cell: Cell;
  attempt: number;
  input: Record<string, unknown>;
  freeTextFields: string[];
  config: CrashtestConfig;
  /** Whole-cell deadline, both server lives included (default 120 s). */
  timeoutMs?: number;
  /** Environment the lab's environment is derived from (default `process.env`). */
  baseEnv?: NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
}

/** What the lab's scripted responder reads from `<runDir>/script.json` (same shape as `ResponderScript` in templates/responder.ts). */
interface ResponderScript {
  tool: string;
  input: Record<string, unknown>;
  idMode: "stable" | "fresh";
  freeTextFields: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 1000;
const HEALTH_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 200;
const EXIT_WAIT_MS = 5000;
const PORT_RELEASE_MS = 5000;
const READY_LINE = /^\[DEV\] ready at /m;
const LOG_TAIL_CHARS = 2000;
const BODY_CHARS = 300;
/** Read by the lab channel (see the channel shim in overlay.ts). */
const SESSION_AUTH_VAR = "CT_SESSION_AUTH";

/** `<outDir>/runs/<tool>/<cellId>-a<attempt>`: one directory per attempt, so evidence of earlier attempts stays. */
export function runDirFor(lab: Lab, tool: string, cellId: CellId, attempt: number): string {
  return join(lab.outDir, "runs", tool, `${cellId}-a${attempt}`);
}

interface Drive {
  sessionId: string | null;
  serverDied: boolean;
  killedBy: RunSummary["killedBy"];
  restarted: boolean;
  turnOutcome: string;
  approvals: number;
  stream: ParsedStream | null;
  errors: string[];
}

export async function runCell(o: RunCellOptions): Promise<RunSummary> {
  const t0 = Date.now();
  const deadline = t0 + (o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const runDir = runDirFor(o.lab, o.tool.name, o.cell.id, o.attempt);
  const fixturesFile = prepareRunDir(runDir, o);
  rmSync(join(o.lab.labDir, ".eve"), { recursive: true, force: true, maxRetries: 5 }); // no run of an earlier cell may resume
  const port = await freePort();
  o.onProgress?.(`[crashtest] ${o.tool.name} ${o.cell.id} a${o.attempt} port=${port}`);

  const ctx: CellContext = { o, runDir, port, base: `http://127.0.0.1:${port}`, deadline, env: cellEnv(o, runDir, fixturesFile) };
  const drive: Drive = { sessionId: null, serverDied: false, killedBy: null, restarted: false, turnOutcome: "timeout", approvals: 0, stream: null, errors: [] };
  const server: { child: ChildProcess | null } = { child: null };
  try {
    await driveCell(ctx, drive, server);
  } finally {
    const released = await stopServer(server.child, port);
    if (!released) drive.errors.push(`port ${port} was still held after the run`);
    // The server is gone, so nothing writes any more: the next cell starts from the prepared lab files again.
    drive.errors.push(...restoreLabFiles(o.lab, writtenPaths(readText(join(runDir, "ledger.jsonl")) ?? "")));
  }

  const ledger = readLedger(join(runDir, "ledger.jsonl"), drive.errors);
  const summary: RunSummary = {
    tool: o.tool.name,
    cellId: o.cell.id,
    attempt: o.attempt,
    crashPoint: o.cell.point,
    idMode: o.cell.idMode,
    latencyMs: o.cell.latencyMs,
    holdMs: o.cell.holdMs,
    eveVersion: o.lab.eveVersion,
    port,
    sessionId: drive.sessionId,
    preloadReady: Boolean(readText(join(runDir, "preload.ready"))?.trim()),
    marker: readText(join(runDir, "crashed.marker")),
    serverDied: drive.serverDied,
    killedBy: drive.killedBy,
    restarted: drive.restarted,
    turnOutcome: drive.turnOutcome,
    approvals: drive.approvals,
    calls: drive.stream?.calls ?? [],
    ledger,
    wallMs: Date.now() - t0,
    runDir,
    ...(drive.errors.length > 0 ? { error: drive.errors.join("\n") } : {}),
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

interface CellContext {
  o: RunCellOptions;
  runDir: string;
  port: number;
  base: string;
  deadline: number;
  env: Record<string, string>;
}

/** Start, send the message, then poll once a second until the turn settles or the deadline passes. */
async function driveCell(ctx: CellContext, d: Drive, server: { child: ChildProcess | null }): Promise<void> {
  const first = await startServer(ctx, "dev1.log", false);
  server.child = first.child;
  if (!first.ready) {
    d.turnOutcome = "startup-failed";
    d.errors.push(first.problem);
    return;
  }

  const created = await createSession(ctx, `crashtest ${ctx.o.tool.name} ${ctx.o.cell.id}`);
  if (typeof created !== "string") {
    d.turnOutcome = "startup-failed";
    d.errors.push(created.problem);
    return;
  }
  d.sessionId = created;

  let child = first.child;
  let monitor = monitorFor(ctx, child);
  let answered = new Set<string>(); // per server life: an approval still open after a restart is answered again
  const lastFailure: { stream?: string; approval?: string } = {};
  while (true) {
    const wait = Math.min(POLL_MS, ctx.deadline - Date.now());
    if (wait <= 0) break;
    await sleep(wait);
    if (Date.now() >= ctx.deadline) break;

    const health = await monitor.check();
    if (health === "down") continue;
    if (health === "dead") {
      if (d.restarted) {
        d.turnOutcome = "died-after-resume";
        d.errors.push(`the server died again after the restart with --resume${logTail(join(ctx.runDir, "dev2.log"))}`);
        return;
      }
      d.serverDied = true;
      d.killedBy = existsSync(join(ctx.runDir, "crashed.marker")) ? "crash-point" : exited(child) ? "unexpected" : "harness";
      await stopServer(child, ctx.port);
      d.restarted = true;
      const next = await startServer(ctx, "dev2.log", true);
      server.child = child = next.child;
      if (!next.ready) {
        d.turnOutcome = "startup-failed";
        d.errors.push(next.problem);
        return;
      }
      monitor = monitorFor(ctx, child);
      answered = new Set();
      continue;
    }

    const read = await readStream(ctx, created);
    if (!read.ok) {
      lastFailure.stream = read.problem;
      if (read.terminal) {
        d.turnOutcome = "stream-failed";
        d.errors.push(read.problem);
        return;
      }
      continue;
    }
    d.stream = read.stream;
    for (const interactionId of read.stream.openInteractions) {
      if (answered.has(interactionId)) continue;
      const answer = await approve(ctx, created, interactionId);
      if (answer.ok) {
        answered.add(interactionId);
        d.approvals += 1;
      } else {
        lastFailure.approval = answer.problem;
      }
    }
    if (read.stream.turnOutcome !== null) {
      d.turnOutcome = read.stream.turnOutcome;
      return;
    }
  }
  // Without the last failures, a rejected answer or an unreadable stream would look like a slow turn.
  d.errors.push(`the turn did not settle within ${Math.round((ctx.o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`);
  if (lastFailure.stream !== undefined) d.errors.push(`last ${lastFailure.stream}`);
  if (lastFailure.approval !== undefined) d.errors.push(`last ${lastFailure.approval}`);
}

/** Fresh run directory with the responder's script and, when configured, the fixtures. Returns the fixtures file. */
function prepareRunDir(runDir: string, o: RunCellOptions): string | undefined {
  rmSync(runDir, { recursive: true, force: true, maxRetries: 5 });
  mkdirSync(runDir, { recursive: true });
  const script: ResponderScript = { tool: o.tool.name, input: o.input, idMode: o.cell.idMode, freeTextFields: o.freeTextFields };
  writeFileSync(join(runDir, "script.json"), `${JSON.stringify(script, null, 2)}\n`);
  if (o.config.fixtures === undefined) return undefined;
  const file = join(runDir, "fixtures.json");
  writeFileSync(file, `${JSON.stringify(o.config.fixtures, null, 2)}\n`);
  return file;
}

/**
 * The lab environment of the cell (see `preloadedLabEnv`): the config `env`, then the cell's own `CT_*`. The preload
 * gets `effects.ignore` too, so a request or file write the config says is not an effect never claims the crash point.
 * The lab channel gets the tool's configured session identity as `CT_SESSION_AUTH`, with the `attributes` eve
 * requires; without one the variable is left out, whatever the config `env` says, and the channel uses eve's local caller.
 */
function cellEnv(o: RunCellOptions, runDir: string, fixturesFile: string | undefined): Record<string, string> {
  const configEnv = Object.fromEntries(Object.entries(o.config.env ?? {}).filter(([name]) => name.toUpperCase() !== SESSION_AUTH_VAR));
  const auth = sessionAuthFor(o.config, o.tool.name);
  return preloadedLabEnv(o.baseEnv ?? process.env, {
    ...configEnv,
    ...(auth === undefined ? {} : { [SESSION_AUTH_VAR]: JSON.stringify({ attributes: {}, ...auth }) }),
    CT_RUN_DIR: runDir,
    CT_LAB_DIR: o.lab.labDir,
    CT_CRASH_POINT: o.cell.point,
    CT_FAKE_LATENCY_MS: String(o.cell.latencyMs),
    CT_SLOW_HOLD_MS: String(o.cell.holdMs),
    CT_EFFECTS_IGNORE: JSON.stringify(o.config.effects?.ignore ?? []),
    ...(fixturesFile === undefined ? {} : { CT_FIXTURES: fixturesFile }),
  });
}

type Started = { child: ChildProcess; ready: true } | { child: ChildProcess; ready: false; problem: string };

/** Spawn `eve dev` with its output in `<runDir>/<logName>` and wait for its ready line, its exit or the deadline. */
async function startServer(ctx: CellContext, logName: string, resume: boolean): Promise<Started> {
  const log = join(ctx.runDir, logName);
  const fd = openSync(log, "w");
  let child: ChildProcess;
  try {
    const args = [ctx.o.lab.eveBin, "dev", "--no-ui", "--no-default-extensions", "--port", String(ctx.port), ...(resume ? ["--resume"] : [])];
    child = spawnTracked(process.execPath, args, { cwd: ctx.o.lab.labDir, env: ctx.env, stdio: ["ignore", fd, fd], windowsHide: true });
  } finally {
    closeSync(fd); // the child has its own copy
  }
  const spawn: { error?: Error } = {};
  child.once("error", (error) => (spawn.error = error));
  const command = `eve dev${resume ? " --resume" : ""}`;
  while (true) {
    if (READY_LINE.test(readText(log) ?? "")) return { child, ready: true };
    if (spawn.error) return { child, ready: false, problem: `${command} could not be started: ${spawn.error.message}` };
    if (exited(child)) {
      return { child, ready: false, problem: `${command} exited (code ${child.exitCode}, signal ${child.signalCode}) before it was ready${logTail(log)}` };
    }
    if (Date.now() >= ctx.deadline) {
      return { child, ready: false, problem: `${command} was not ready before the cell deadline${logTail(log)}` };
    }
    await sleep(Math.min(READY_POLL_MS, Math.max(1, ctx.deadline - Date.now())));
  }
}

/**
 * Kill the server's tree and whatever still listens on its port, then wait (bounded) until the child is gone
 * and the port is free. False when something still listens on the port afterwards.
 */
async function stopServer(child: ChildProcess | null, port: number): Promise<boolean> {
  if (child) killTree(child);
  killPort(port);
  if (child) await exitedWithin(child, EXIT_WAIT_MS);
  const until = Date.now() + PORT_RELEASE_MS;
  while (true) {
    const pids = listenerPids(port);
    if (pids === null || pids.length === 0) return true;
    if (Date.now() >= until) return false;
    killPort(port);
    await sleep(200);
  }
}

function monitorFor(ctx: CellContext, child: ChildProcess): HealthMonitor {
  return new HealthMonitor({
    childExited: () => exited(child),
    probe: async () => {
      const signal = timeoutSignal(ctx, HEALTH_TIMEOUT_MS);
      if (signal === null) return false;
      const res = await fetch(`${ctx.base}/eve/v1/health`, { signal });
      await res.arrayBuffer();
      return res.ok;
    },
  });
}

async function createSession(ctx: CellContext, message: string): Promise<string | { problem: string }> {
  const signal = timeoutSignal(ctx, REQUEST_TIMEOUT_MS);
  if (signal === null) return { problem: "no time left to create the session" };
  try {
    const res = await fetch(`${ctx.base}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal,
    });
    const text = await res.text();
    let sessionId: unknown;
    try {
      sessionId = (JSON.parse(text) as { sessionId?: unknown }).sessionId;
    } catch {
      // reported below
    }
    if (res.ok && typeof sessionId === "string" && sessionId !== "") return sessionId;
    return { problem: `session create failed: ${httpProblem(res.status, text)}` };
  } catch (error) {
    return { problem: `session create failed: ${describeError(error)}` };
  }
}

async function readStream(ctx: CellContext, sessionId: string): Promise<StreamRead> {
  const signal = timeoutSignal(ctx, REQUEST_TIMEOUT_MS);
  if (signal === null) return { ok: false, terminal: false, problem: "stream read failed: no time left before the cell deadline" };
  return readSessionStream(ctx.base, sessionId, signal);
}

async function approve(ctx: CellContext, sessionId: string, interactionId: string): Promise<ApprovalAnswer> {
  const signal = timeoutSignal(ctx, REQUEST_TIMEOUT_MS);
  if (signal === null) return { ok: false, problem: `approval answer for ${interactionId} failed: no time left before the cell deadline` };
  return answerApproval(ctx.base, sessionId, interactionId, signal);
}

/** Statuses after which the session's stream will not come back: the session is unknown or gone. */
const STREAM_GONE = new Set([404, 410]);

export type StreamRead = { ok: true; stream: ParsedStream } | { ok: false; terminal: boolean; problem: string };

/**
 * The recorded history of a session (`follow=false` ends at the recorded tail). A failure keeps the HTTP status and
 * the start of the body, or the error; it is `terminal` when the session is unknown or gone (404, 410).
 */
export async function readSessionStream(base: string, sessionId: string, signal: AbortSignal): Promise<StreamRead> {
  try {
    const res = await fetch(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?follow=false`, { signal });
    const text = await res.text();
    if (res.ok) return { ok: true, stream: parseStream(text) };
    return { ok: false, terminal: STREAM_GONE.has(res.status), problem: `stream read failed: ${httpProblem(res.status, text)}` };
  } catch (error) {
    return { ok: false, terminal: false, problem: `stream read failed: ${describeError(error)}` };
  }
}

export type ApprovalAnswer = { ok: true } | { ok: false; problem: string };

/** Answer one open interaction with the "approve" option. A rejected answer keeps the HTTP status and the start of the body. */
export async function answerApproval(base: string, sessionId: string, interactionId: string, signal: AbortSignal): Promise<ApprovalAnswer> {
  try {
    const res = await fetch(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ interactionId, optionId: "approve" }] }),
      signal,
    });
    const text = await res.text();
    if (res.ok) return { ok: true };
    return { ok: false, problem: `approval answer for ${interactionId} failed: ${httpProblem(res.status, text)}` };
  } catch (error) {
    return { ok: false, problem: `approval answer for ${interactionId} failed: ${describeError(error)}` };
  }
}

function httpProblem(status: number, body: string): string {
  const text = body.trim();
  return `HTTP ${status}${text === "" ? "" : ` ${text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}...` : text}`}`;
}

/** The error message plus its cause (fetch reports "fetch failed" and keeps the reason, e.g. ECONNREFUSED, in `cause`). */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const detail = typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : undefined;
  return detail === undefined ? message : `${message} (${detail})`;
}

/** A signal that aborts after `cap` ms or at the cell deadline, whichever comes first; null when the deadline passed. */
function timeoutSignal(ctx: CellContext, cap: number): AbortSignal | null {
  const remaining = ctx.deadline - Date.now();
  return remaining > 0 ? AbortSignal.timeout(Math.min(cap, remaining)) : null;
}

/** Ledger entries in file order. A line that is not JSON (a write cut by the kill) is skipped and reported. */
function readLedger(file: string, errors: string[]): LedgerEntry[] {
  const text = readText(file);
  if (text === null) return [];
  const entries: LedgerEntry[] = [];
  text.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      entries.push(JSON.parse(line) as LedgerEntry);
    } catch {
      errors.push(`ledger line ${index + 1} is not JSON: ${line.slice(0, 200)}`);
    }
  });
  return entries;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function logTail(log: string): string {
  const text = (readText(log) ?? "").trim();
  if (text === "") return ` (${log} is empty)`;
  return `\n--- ${log} (tail) ---\n${text.length > LOG_TAIL_CHARS ? `...${text.slice(-LOG_TAIL_CHARS)}` : text}`;
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function exitedWithin(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
