// Runs one cell: one `eve dev` life in the lab with one crash point. The preload (or the probe hook) SIGKILLs
// the server at the crash point; the runner notices, restarts it once with `--resume`, approves whatever the
// turn asks for, waits for the turn to settle and returns a summary that names everything it was run with.
// Target failures never throw: they end up in `turnOutcome` and `error`.
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CrashtestConfig } from "../config.ts";
import { labEnv, type Lab } from "../lab.ts";
import { preloadPath } from "../paths.ts";
import type { Cell, CellId, LedgerEntry, RunSummary, ToolInfo } from "../types.ts";
import { HealthMonitor } from "./health.ts";
import { freePort, killPort, listenerPids } from "./ports.ts";
import { killTree, preloadImportFlag, spawnTracked, withPreload } from "./process.ts";
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

    const stream = await readStream(ctx, created);
    if (stream === null) continue;
    d.stream = stream;
    for (const interactionId of stream.openInteractions) {
      if (answered.has(interactionId)) continue;
      if (await approve(ctx, created, interactionId)) {
        answered.add(interactionId);
        d.approvals += 1;
      }
    }
    if (stream.turnOutcome !== null) {
      d.turnOutcome = stream.turnOutcome;
      return;
    }
  }
  d.errors.push(`the turn did not settle within ${Math.round((ctx.o.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s`);
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
 * The lab environment of the cell: the base environment without credentials and without any `CT_*` left over
 * from the caller, then the config `env`, then the cell's own `CT_*`. The preload is appended to NODE_OPTIONS.
 * CLI telemetry is off: the eve CLI reports an unexpected server exit, which would land in the ledger as an effect.
 */
function cellEnv(o: RunCellOptions, runDir: string, fixturesFile: string | undefined): Record<string, string> {
  const base = Object.fromEntries(Object.entries(o.baseEnv ?? process.env).filter(([name]) => !/^CT_/i.test(name)));
  const configured = o.config.env ?? {};
  return labEnv(base, {
    ...configured,
    EVE_TELEMETRY_DISABLED: "1",
    CT_RUN_DIR: runDir,
    CT_LAB_DIR: o.lab.labDir,
    CT_CRASH_POINT: o.cell.point,
    CT_FAKE_LATENCY_MS: String(o.cell.latencyMs),
    CT_SLOW_HOLD_MS: String(o.cell.holdMs),
    ...(fixturesFile === undefined ? {} : { CT_FIXTURES: fixturesFile }),
    NODE_OPTIONS: withPreload(configured.NODE_OPTIONS ?? base.NODE_OPTIONS, preloadImportFlag(preloadPath())),
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
    return { problem: `session create failed: HTTP ${res.status} ${text.slice(0, 500)}` };
  } catch (error) {
    return { problem: `session create failed: ${(error as Error).message}` };
  }
}

/** The recorded history of the session (`follow=false` ends at the recorded tail), or null when it could not be read. */
async function readStream(ctx: CellContext, sessionId: string): Promise<ParsedStream | null> {
  const signal = timeoutSignal(ctx, REQUEST_TIMEOUT_MS);
  if (signal === null) return null;
  try {
    const res = await fetch(`${ctx.base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream?follow=false`, { signal });
    const text = await res.text();
    return res.ok ? parseStream(text) : null;
  } catch {
    return null;
  }
}

/** Answer one open interaction with the "approve" option. True when eve accepted the answer. */
async function approve(ctx: CellContext, sessionId: string, interactionId: string): Promise<boolean> {
  const signal = timeoutSignal(ctx, REQUEST_TIMEOUT_MS);
  if (signal === null) return false;
  try {
    const res = await fetch(`${ctx.base}/eve/v1/session/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: [{ interactionId, optionId: "approve" }] }),
      signal,
    });
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
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
