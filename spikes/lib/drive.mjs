#!/usr/bin/env node
// SPIKE (throwaway): cross-platform crash driver for eve agents.
// node spikes/lib/drive.mjs --app <dir> --port <n> --message "<text>" [--expect-crash] [--auto-approve] [--timeout-s 120]
// Prints exactly one JSON summary line on stdout. Exit 0 = summary produced, 1 = startup failure or timeout.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { killPort as killListener } from "./ports.mjs";

const { values: o } = parseArgs({
  options: {
    app: { type: "string" },
    port: { type: "string" },
    message: { type: "string" },
    "expect-crash": { type: "boolean", default: false },
    "auto-approve": { type: "boolean", default: false },
    "timeout-s": { type: "string", default: "120" },
  },
});
if (!o.app || !o.port || !o.message) {
  console.error("usage: drive.mjs --app <dir> --port <n> --message <text> [--expect-crash] [--auto-approve] [--timeout-s N]");
  process.exit(2);
}

const IS_WIN = process.platform === "win32";
const app = resolve(o.app);
const port = Number(o.port);
const base = `http://127.0.0.1:${port}`;
const runDir = join(app, ".ct-run");
const ledgerPath = join(runDir, "ledger.jsonl");
const t0 = Date.now();
const deadline = t0 + Number(o["timeout-s"]) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only the LISTENING process, never the caller (final-review finding 1; see ports.mjs).
const killPort = () => killListener(port);

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
  else { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
}

function tail(file, n = 40) {
  try { return readFileSync(file, "utf8").split(/\r?\n/).slice(-n).join("\n"); } catch { return "(no log)"; }
}

async function startDev(logName, extra) {
  const log = join(runDir, logName);
  const out = createWriteStream(log);
  const child = spawn("npx", ["eve", "dev", "--no-ui", "--port", String(port), ...extra], {
    cwd: app,
    env: { ...process.env, CT_RUN_DIR: runDir, CT_LEDGER: ledgerPath },
    shell: IS_WIN,
    detached: !IS_WIN,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  while (Date.now() < deadline) {
    await sleep(500);
    if (/^\[DEV\] ready at /m.test(tail(log, 200))) return { child, log };
    if (child.exitCode !== null) break;
  }
  killTree(child);
  return { child: null, log };
}

async function up() {
  try { await fetch(`${base}/eve/v1/health`, { signal: AbortSignal.timeout(2000) }); return true; }
  catch { return false; }
}

async function facts(sessionId) {
  try {
    const res = await fetch(`${base}/eve/v1/session/${sessionId}/stream?follow=false`, { signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    const all = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (Array.isArray(e.facts)) all.push(...e.facts); } catch {}
    }
    return all;
  } catch { return null; }
}

function readLedger() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return { raw: l }; }
  });
}

function fail(msg, log) {
  console.error(`drive: ${msg}\n--- ${log} (tail) ---\n${tail(log)}`);
  killPort();
  process.exit(1);
}

// ---- run ----
killPort();
rmSync(join(app, ".eve"), { recursive: true, force: true });
rmSync(runDir, { recursive: true, force: true });
mkdirSync(runDir, { recursive: true });

let dev = await startDev("dev1.log", []);
if (!dev.child) fail("eve dev failed to start", dev.log);
const logs = { dev1: dev.log };

const created = await fetch(`${base}/eve/v1/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: o.message }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
const sessionId = created.sessionId;
if (!sessionId) fail(`session create failed: ${JSON.stringify(created)}`, dev.log);

let serverDied = false;
let restarted = false;
let turnOutcome = "timeout";
let lastFacts = [];
const answered = new Set();

while (Date.now() < deadline) {
  await sleep(1000);
  if (!(await up())) {
    if (restarted) continue;
    serverDied = true;
    killTree(dev.child);
    killPort();
    dev = await startDev("dev2.log", ["--resume"]);
    logs.dev2 = dev.log;
    if (!dev.child) fail("eve dev --resume failed to start", dev.log);
    restarted = true;
    continue;
  }
  const f = await facts(sessionId);
  if (!f) continue;
  lastFacts = f;
  if (o["auto-approve"]) {
    for (const x of f) {
      const id = x.data?.interactionId;
      if (x.type === "interaction.opened" && id && !answered.has(id)) {
        answered.add(id);
        await fetch(`${base}/eve/v1/session/${sessionId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answers: [{ interactionId: id, optionId: "approve" }] }),
        }).catch(() => {});
      }
    }
  }
  const settled = f.findLast((x) => x.type === "turn.settled");
  if (settled) { turnOutcome = settled.data?.outcome ?? "unknown"; break; }
}

const calls = new Map();
for (const x of lastFacts) {
  const id = x.data?.callId;
  if (!id) continue;
  if (x.type === "call.requested") calls.set(id, { callId: id, tool: x.data?.capability?.name ?? "?", outcome: "requested" });
  if (x.type === "call.settled") {
    const c = calls.get(id) ?? { callId: id, tool: "?" };
    c.outcome = x.data?.outcome ?? "settled";
    if (x.data?.error) c.error = x.data.error;
    if (x.data?.output !== undefined) c.output = x.data.output;
    calls.set(id, c);
  }
}

killTree(dev.child);
killPort();

const markerPath = join(runDir, "crashed.marker");
console.log(JSON.stringify({
  sessionId, serverDied, restarted, turnOutcome, expectCrash: o["expect-crash"],
  crashPoint: process.env.CT_CRASH_POINT ?? "none",
  fakeLatencyMs: Number(process.env.CT_FAKE_LATENCY_MS ?? 0),
  marker: existsSync(markerPath) ? readFileSync(markerPath, "utf8") : null,
  calls: [...calls.values()], ledger: readLedger(), wallMs: Date.now() - t0, logs,
}));
process.exit(turnOutcome === "timeout" ? 1 : 0);
