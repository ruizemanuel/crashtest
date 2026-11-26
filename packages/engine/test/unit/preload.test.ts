import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { preloadImportFlag, withPreload } from "../../src/driver/process.ts";
import { preloadPath } from "../../src/paths.ts";
import type { LedgerEntry } from "../../src/types.ts";

const CHILD = fileURLToPath(new URL("./preload-child.mjs", import.meta.url));
const FLAG = preloadImportFlag(preloadPath());
const CHILD_TIMEOUT_MS = 30_000;
// Timers may fire about a millisecond early against a monotonic clock; durations are checked with this margin.
const TIMER_SLACK_MS = 10;

interface ChildOutput {
  pid: number;
  code: number | null;
  exitedAt: number;
  events: Array<Record<string, any>>;
  stderr: string;
}

interface ChildOptions {
  /** Defaults to a fresh temp directory; pass the same one twice to model two processes of one run. */
  runDir?: string | null;
  env?: Record<string, string>;
  nodeOptions?: string;
  cwd?: string;
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-preload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runChild(scenario: string, options: ChildOptions & { runDir: string | null }): Promise<ChildOutput> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name === "NODE_OPTIONS" || name.startsWith("CT_")) delete env[name];
  env.NODE_OPTIONS = options.nodeOptions ?? withPreload(undefined, FLAG);
  if (options.runDir !== null) env.CT_RUN_DIR = options.runDir;
  Object.assign(env, options.env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, scenario], { env, cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
      resolve({ pid: child.pid ?? -1, code, exitedAt: Date.now(), events, stderr });
    });
  });
}

const run = (t: TestContext, scenario: string, options: Omit<ChildOptions, "runDir"> = {}) => runChild(scenario, { ...options, runDir: tempDir(t) });
const eventOf = (out: ChildOutput, name: string) => out.events.find((e) => e.event === name);
const printedAfter = (out: ChildOutput) => eventOf(out, "after") !== undefined;

function readLedgerText(runDir: string): string {
  const file = join(runDir, "ledger.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readLedger(runDir: string): LedgerEntry[] {
  return readLedgerText(runDir).split("\n").filter(Boolean).map((line) => JSON.parse(line) as LedgerEntry);
}

test("inactive without CT_RUN_DIR", async (t) => {
  const cwd = tempDir(t);
  const out = await runChild("idle", { runDir: null, cwd });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(printedAfter(out), true);
  assert.deepEqual(readdirSync(cwd), []);
});

test("POST to Stripe is faked, ledgered and redacted", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("refund", { runDir });
  assert.equal(out.code, 0, out.stderr);
  const response = eventOf(out, "response");
  assert.equal(response?.status, 200);
  assert.equal(response?.body.id, "re_ct_000001");
  assert.equal(printedAfter(out), true);

  const ledger = readLedger(runDir);
  assert.equal(ledger.length, 1);
  const [entry] = ledger;
  assert.equal(entry.seq, 1);
  assert.equal(entry.pid, out.pid);
  assert.equal(entry.kind, "http");
  assert.equal(entry.method, "POST");
  assert.equal(entry.url, "https://api.stripe.com/v1/refunds");
  assert.equal(entry.endpoint, "POST api.stripe.com/v1/refunds");
  assert.equal(entry.mutating, true);
  assert.equal(entry.stateChange, true);
  assert.equal(entry.status, 200);
  assert.deepEqual(entry.body, { charge: "ch_1", amount: 500 });
  assert.equal("benign" in entry, false);
  assert.equal("idempotencyKey" in entry, false);
  // The Authorization header was sent, and no header is ever recorded.
  assert.equal(readLedgerText(runDir).includes("sk_live_secret"), false);
  assert.equal(readLedgerText(runDir).toLowerCase().includes("authorization"), false);
  assert.equal(readFileSync(join(runDir, "provider-state.json"), "utf8").includes("sk_live_secret"), false);
});

test("ledger urls never carry secrets, including webhook urls", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("webhook", { runDir });
  assert.equal(out.code, 0, out.stderr);
  const [entry, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  assert.equal(entry.url, "https://hooks.slack.com/services/[redacted]?key=[redacted]");
  assert.equal(entry.endpoint, "POST hooks.slack.com/services/[redacted]");
  for (const file of ["ledger.jsonl", "provider-state.json"]) {
    const text = readFileSync(join(runDir, file), "utf8");
    assert.equal(text.includes("XyZsecret"), false, file);
    assert.equal(text.includes("k9"), false, file);
  }
});

test("loopback passes through", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("loopback", { runDir });
  assert.equal(out.code, 0, out.stderr);
  const response = eventOf(out, "response");
  assert.equal(response?.status, 200);
  assert.deepEqual(response?.body, { ok: "loopback" });
  assert.deepEqual(response?.received, [{ method: "POST", url: "/hook", body: JSON.stringify({ n: 1 }) }]);
  assert.deepEqual(readLedger(runDir), []);
});

test("post-effect-fast kills after recording", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("refund", { runDir, env: { CT_CRASH_POINT: "post-effect-fast" } });
  // A SIGKILLed child reports a signal on POSIX and a non-zero exit code on Windows.
  assert.notEqual(out.code, 0);
  assert.equal(printedAfter(out), false);
  assert.equal(eventOf(out, "response"), undefined);
  assert.equal(readFileSync(join(runDir, "crashed.marker"), "utf8"), `post-effect-fast pid=${out.pid}`);
  const ledger = readLedger(runDir);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].endpoint, "POST api.stripe.com/v1/refunds");
  // The state was saved before the process died, so a later process continues the id sequence.
  const state = JSON.parse(readFileSync(join(runDir, "provider-state.json"), "utf8")) as { counters: Record<string, number> };
  assert.equal(state.counters.refund, 1);
});

test("post-effect-slow holds then kills", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("refund", { runDir, env: { CT_CRASH_POINT: "post-effect-slow", CT_SLOW_HOLD_MS: "300" } });
  assert.notEqual(out.code, 0);
  assert.equal(printedAfter(out), false);
  assert.match(readFileSync(join(runDir, "crashed.marker"), "utf8"), /^post-effect-slow pid=\d+$/);
  const [entry, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  // The request was recorded on arrival and the process stayed alive for the hold before it died.
  assert.ok(out.exitedAt - Date.parse(entry.ts) >= 300 - TIMER_SLACK_MS, `died ${out.exitedAt - Date.parse(entry.ts)} ms after the request`);
});

test("marker makes the crash happen once", async (t) => {
  const runDir = tempDir(t);
  const env = { CT_CRASH_POINT: "post-effect-fast" };
  const first = await runChild("refund", { runDir, env });
  assert.equal(printedAfter(first), false);
  const second = await runChild("refund", { runDir, env });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(printedAfter(second), true);
  assert.equal(eventOf(second, "response")?.body.id, "re_ct_000002");
  const ledger = readLedger(runDir);
  assert.deepEqual(ledger.map((e) => [e.seq, e.pid]), [[1, first.pid], [2, second.pid]]);
  assert.match(readFileSync(join(runDir, "crashed.marker"), "utf8"), new RegExp(`^post-effect-fast pid=${first.pid}$`));
});

test("only mutating requests trigger the crash and other crash points are left to the engine", async (t) => {
  const lookupRunDir = tempDir(t);
  const out = await runChild("lookup-then-refund", { runDir: lookupRunDir, env: { CT_CRASH_POINT: "post-effect-fast" } });
  assert.equal(eventOf(out, "lookup")?.status, 200);
  assert.equal(eventOf(out, "response"), undefined);
  assert.equal(printedAfter(out), false);
  assert.deepEqual(readLedger(lookupRunDir).map((e) => [e.method, e.mutating]), [["GET", false], ["POST", true]]);

  for (const point of ["none", "post-settle"]) {
    const runDir = tempDir(t);
    const calm = await runChild("refund", { runDir, env: { CT_CRASH_POINT: point } });
    assert.equal(calm.code, 0, calm.stderr);
    assert.equal(printedAfter(calm), true, point);
    assert.equal(existsSync(join(runDir, "crashed.marker")), false, point);
  }
});

test("state persists across processes", async (t) => {
  const runDir = tempDir(t);
  const first = await runChild("refund-keyed", { runDir });
  const second = await runChild("refund-keyed", { runDir });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(eventOf(second, "response")?.status, 200);
  assert.deepEqual(eventOf(second, "response")?.body, eventOf(first, "response")?.body);
  const [one, two, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  assert.equal(one.idempotencyKey, "k1");
  assert.equal(one.stateChange, true);
  assert.equal(one.benign, undefined);
  assert.equal(two.idempotencyKey, "k1");
  assert.equal(two.stateChange, false);
  assert.equal(two.benign, "idempotency key replay");
  assert.deepEqual([one.seq, two.seq], [1, 2]);
});

test("latency delays the response", async (t) => {
  const out = await run(t, "refund", { env: { CT_FAKE_LATENCY_MS: "300" } });
  assert.equal(out.code, 0, out.stderr);
  assert.ok(eventOf(out, "response")?.elapsedMs >= 300 - TIMER_SLACK_MS, `responded after ${eventOf(out, "response")?.elapsedMs} ms`);
});

test("fixtures override", async (t) => {
  const fixtures = join(tempDir(t), "fixtures.json");
  writeFileSync(fixtures, JSON.stringify([{ url: "https://api.acme.test/*", status: 201, body: { x: 1 } }]));
  const runDir = tempDir(t);
  const out = await runChild("acme", { runDir, env: { CT_FIXTURES: fixtures } });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(eventOf(out, "response")?.status, 201);
  assert.deepEqual(eventOf(out, "response")?.body, { x: 1 });
  const [entry] = readLedger(runDir);
  assert.deepEqual([entry.endpoint, entry.status, entry.stateChange], ["POST api.acme.test/v1/things", 201, true]);
});

test("a fixture with a body-less status answers without a body", async (t) => {
  const fixtures = join(tempDir(t), "fixtures.json");
  writeFileSync(fixtures, JSON.stringify([{ url: "https://api.acme.test/empty", status: 204 }]));
  const out = await runChild("acme-empty", { runDir: tempDir(t), env: { CT_FIXTURES: fixtures } });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(eventOf(out, "response")?.status, 204);
  assert.equal(eventOf(out, "response")?.body, "");
});

test("loads alongside existing NODE_OPTIONS", async (t) => {
  const runDir = tempDir(t);
  const out = await runChild("refund", { runDir, nodeOptions: withPreload("--max-old-space-size=512", FLAG) });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readFileSync(join(runDir, "preload.ready"), "utf8"), `${out.pid}\n`);
  assert.equal(readLedger(runDir).length, 1);
});
