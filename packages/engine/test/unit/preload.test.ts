import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

test("a request that effects.ignore names never claims the crash: the crash follows the next effect", async (t) => {
  const runDir = tempDir(t);
  const env = { CT_CRASH_POINT: "post-effect-fast", CT_EFFECTS_IGNORE: JSON.stringify(["https://api.vercel.com/v1/connect/*"]) };
  const out = await runChild("token-then-refund", { runDir, env });
  assert.notEqual(out.code, 0);
  // The ignored POST was answered; the process died after the refund, before its answer.
  assert.equal(eventOf(out, "token")?.status, 200);
  assert.equal(eventOf(out, "response"), undefined);
  assert.equal(printedAfter(out), false);
  assert.equal(readFileSync(join(runDir, "crashed.marker"), "utf8"), `post-effect-fast pid=${out.pid}`);
  // Both are in the ledger, the ignored one too: detection leaves it out when it counts.
  assert.deepEqual(readLedger(runDir).map((e) => [e.endpoint, e.mutating]), [["POST api.vercel.com/v1/connect/token/slack%2Fsre", true], ["POST api.stripe.com/v1/refunds", true]]);

  // Without the ignore list the first POST claims the crash.
  const plainRunDir = tempDir(t);
  const plain = await runChild("token-then-refund", { runDir: plainRunDir, env: { CT_CRASH_POINT: "post-effect-fast" } });
  assert.equal(eventOf(plain, "token"), undefined);
  assert.deepEqual(readLedger(plainRunDir).map((e) => e.endpoint), ["POST api.vercel.com/v1/connect/token/slack%2Fsre"]);
});

test("an ignore list that is not a JSON array of strings stops the process before it runs", async (t) => {
  for (const value of ["not json", '{"a":1}', "[1]"]) {
    const runDir = tempDir(t);
    const out = await runChild("refund", { runDir, env: { CT_EFFECTS_IGNORE: value } });
    assert.notEqual(out.code, 0, value);
    assert.equal(printedAfter(out), false, value);
    assert.match(out.stderr, /CT_EFFECTS_IGNORE/, value);
    assert.deepEqual(readLedger(runDir), [], value);
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

test("an unreadable provider state fails the request visibly and is never replaced by a fresh one", async (t) => {
  // An empty file is what a reader sees between another process's truncate and write; the others are damaged content.
  for (const damaged of ["", '{"counters":{"refund":4', "null", "[]"]) {
    const runDir = tempDir(t);
    const stateFile = join(runDir, "provider-state.json");
    writeFileSync(stateFile, damaged);
    const out = await runChild("refund", { runDir, env: { CT_CRASH_POINT: "post-effect-fast" } });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(eventOf(out, "response")?.status, 500, JSON.stringify(damaged));
    assert.equal(readFileSync(stateFile, "utf8"), damaged);
    // The run is invalid, not recorded and not crashed: no ledger entry, no marker.
    assert.deepEqual(readLedger(runDir), []);
    assert.equal(existsSync(join(runDir, "crashed.marker")), false);
  }
});

test("the state is written atomically and leaves nothing behind", async (t) => {
  const runDir = tempDir(t);
  const stateFile = join(runDir, "provider-state.json");
  const first = await runChild("refund", { runDir });
  const before = statSync(stateFile, { bigint: true }).ino;
  const second = await runChild("refund", { runDir });
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  // A new file replaced the old one (rename) instead of the old one being truncated and rewritten in place.
  assert.notEqual(statSync(stateFile, { bigint: true }).ino, before);
  assert.deepEqual(readdirSync(runDir).sort(), ["ledger.jsonl", "preload.ready", "provider-state.json"]);
  assert.equal(JSON.parse(readFileSync(join(runDir, "provider-state.json"), "utf8")).counters.refund, 2);
});

// --- file-system effects -----------------------------------------------------------------------------------------

/** Runs an fs scenario with `lab` as both CT_LAB_DIR and the working directory, as eve dev runs in the lab. */
async function runInLab(t: TestContext, scenario: string, options: { lab?: string; runDir?: string; env?: Record<string, string> } = {}) {
  const lab = options.lab ?? tempDir(t);
  const runDir = options.runDir ?? tempDir(t);
  const env = { CT_LAB_DIR: lab, CT_TEST_OUTSIDE: tempDir(t), ...options.env };
  return { out: await runChild(scenario, { runDir, cwd: lab, env }), lab, runDir };
}

const OUTBOX = `${JSON.stringify({ to: "alice", orderId: "ord_1" })}\n`;

test("an append inside the lab is an effect of the ledger", async (t) => {
  const { out, lab, runDir } = await runInLab(t, "fs-append");
  assert.equal(out.code, 0, out.stderr);
  assert.equal(printedAfter(out), true);
  // The write itself happened.
  assert.equal(readFileSync(join(lab, "data", "outbox.jsonl"), "utf8"), OUTBOX);
  const [entry, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  assert.equal(entry.seq, 1);
  assert.equal(entry.pid, out.pid);
  assert.equal(entry.kind, "fs");
  assert.equal(entry.method, "APPEND");
  assert.equal(entry.url, "data/outbox.jsonl");
  assert.equal(entry.endpoint, "APPEND data/outbox.jsonl");
  // What detection counts.
  assert.equal(entry.mutating, true);
  assert.equal(entry.stateChange, true);
  assert.equal(entry.status, 0);
  assert.equal("benign" in entry, false);
  assert.deepEqual(entry.body, { to: "alice", orderId: "ord_1" });
});

test("every node:fs write form is observed once, through named imports, namespaces and promises", async (t) => {
  const { out, lab, runDir } = await runInLab(t, "fs-forms");
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(
    readLedger(runDir).map((e) => [e.seq, e.kind, e.method, e.url, e.body]),
    [
      [1, "fs", "WRITE", "data/a.txt", "one"],
      [2, "fs", "APPEND", "data/b.log", "two\n"],
      [3, "fs", "APPEND", "data/c.log", "three\n"],
      [4, "fs", "WRITE", "data/d.txt", "four"],
      [5, "fs", "APPEND", "data/e.log", "five\n"],
      [6, "fs", "WRITE", "data/f.txt", "six"],
      [7, "fs", "WRITE", "data/g.txt", "seven"],
      [8, "fs", "APPEND", "data/h.log", "eight\n"],
      [9, "fs", "WRITE", "data/i.txt", "nine"],
      [10, "fs", "WRITE", "data/j.txt", "ten"],
    ],
  );
  // Observing a write never changes what it does.
  assert.equal(readFileSync(join(lab, "data", "g.txt"), "utf8"), "seven");
  assert.equal(readFileSync(join(lab, "data", "e.log"), "utf8"), "five\n");
});

test("only effects inside the lab count: eve state, idempotency records, dependencies, the run directory and outside paths are left out", async (t) => {
  const lab = tempDir(t);
  const runDir = join(lab, "ct-run"); // a run directory inside the lab is still not an effect of the tool
  const { out } = await runInLab(t, "fs-ignored", { lab, runDir });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(readLedger(runDir).map((e) => [e.method, e.url]), [["WRITE", ".eve-notes/n.txt"], ["WRITE", "data/kept.txt"]]);
  // The preload's own files were written even though node:fs was wrapped, and none of them is an effect.
  assert.equal(readFileSync(join(runDir, "note.txt"), "utf8"), "in the run directory");
  assert.deepEqual(readdirSync(runDir).sort(), ["ledger.jsonl", "note.txt", "preload.ready", "provider-state.json"]);
});

test("a lab reached through a link is the same lab", async (t) => {
  // The lab is configured by one path and the process works in it by another, as with /var and /private/var on macOS.
  const real = tempDir(t);
  const link = join(tempDir(t), "lab-link");
  symlinkSync(real, link, "junction");
  const { out, runDir } = await runInLab(t, "fs-append", { lab: real, env: { CT_LAB_DIR: link } });
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(readLedger(runDir).map((e) => [e.method, e.url]), [["APPEND", "data/outbox.jsonl"]]);
});

test("descriptor and stream writes are not observed", async (t) => {
  const { out, lab, runDir } = await runInLab(t, "fs-unobserved");
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readFileSync(join(lab, "data", "fd.txt"), "utf8"), "through a descriptoragain");
  assert.equal(readFileSync(join(lab, "data", "stream.txt"), "utf8"), "through a stream");
  assert.deepEqual(readLedger(runDir), []);
});

test("a Node child process of the app is observed too", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-child-process");
  assert.equal(out.code, 0, out.stderr);
  const [entry, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  assert.deepEqual([entry.method, entry.url, entry.body], ["WRITE", "data/from-child.txt", "from a child"]);
  assert.notEqual(entry.pid, out.pid);
});

test("without CT_LAB_DIR file writes are not observed", async (t) => {
  const lab = tempDir(t);
  const runDir = tempDir(t);
  const out = await runChild("fs-append", { runDir, cwd: lab });
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readFileSync(join(lab, "data", "outbox.jsonl"), "utf8"), OUTBOX);
  assert.deepEqual(readLedger(runDir), []);
});

test("the preload's own files never pass through a wrapped node:fs function", async (t) => {
  // The run directory is inside the lab, where only the path filter would keep its files out of the ledger.
  const lab = tempDir(t);
  const runDir = join(lab, "ct-run");
  const { out } = await runInLab(t, "fs-spied", { lab, runDir });
  assert.equal(out.code, 0, out.stderr);
  const paths = eventOf(out, "reached")?.paths as string[];
  // The spy saw the tool's own calls, and nothing the preload wrote (ledger, state).
  assert.ok(paths.some((p) => p.endsWith("outbox.jsonl")), JSON.stringify(paths));
  assert.deepEqual(paths.filter((p) => p.startsWith(runDir)), []);
  assert.deepEqual(readLedger(runDir).map((e) => [e.kind, e.endpoint]), [["http", "POST api.stripe.com/v1/refunds"], ["fs", "APPEND data/outbox.jsonl"], ["fs", "APPEND data/outbox.jsonl"]]);
});

test("a repeated write with the same content is benign, a different one is not", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-write-repeat");
  assert.equal(out.code, 0, out.stderr);
  const ledger = readLedger(runDir);
  assert.deepEqual(ledger.map((e) => [e.endpoint, e.mutating, e.stateChange]), [["WRITE data/state.json", true, true], ["WRITE data/state.json", true, false], ["WRITE data/state.json", true, true]]);
  assert.equal(ledger[1].benign, "same content rewritten");
  assert.equal(ledger[2].benign, undefined);
  const state = JSON.parse(readFileSync(join(runDir, "provider-state.json"), "utf8")) as { fsWrites: Record<string, string> };
  assert.deepEqual(Object.keys(state.fsWrites), ["WRITE data/state.json"]);
});

test("the ledger keeps 2 KB of a large write but the comparison sees all of it", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-large");
  assert.equal(out.code, 0, out.stderr);
  const ledger = readLedger(runDir);
  assert.deepEqual(ledger.map((e) => e.stateChange), [true, true, false]);
  for (const entry of ledger) {
    assert.equal(typeof entry.body, "string");
    assert.equal((entry.body as string).length, 2048);
  }
});

test("secrets in a written JSON file are redacted in the ledger and the state, cut or not", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-secret");
  assert.equal(out.code, 0, out.stderr);
  const [small, large] = readLedger(runDir);
  assert.deepEqual(small.body, { password: "[redacted]", n: 1 });
  assert.equal(typeof large.body, "string");
  assert.equal((large.body as string).length, 2048);
  assert.match(large.body as string, /^\{"apiKey":"\[redacted\]","items":\["item-0"/);
  for (const file of ["ledger.jsonl", "provider-state.json"]) assert.equal(readFileSync(join(runDir, file), "utf8").includes("hunter2"), false, file);
});

test("a write that fails is not an effect", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-failed");
  assert.equal(out.code, 0, out.stderr);
  assert.deepEqual(out.events.filter((e) => e.event !== "after").map((e) => e.event), ["failed", "failed", "wrote", "failed"]);
  assert.deepEqual(readLedger(runDir).map((e) => [e.method, e.url]), [["WRITE", "data/kept.txt"]]);
});

test("post-effect-fast kills after a file write, whichever form it takes", async (t) => {
  for (const scenario of ["fs-append", "fs-append-callback", "fs-append-promise"]) {
    const { out, lab, runDir } = await runInLab(t, scenario, { env: { CT_CRASH_POINT: "post-effect-fast" } });
    assert.notEqual(out.code, 0, scenario);
    assert.equal(printedAfter(out), false, scenario);
    // The write was done and recorded first, then the process died.
    assert.equal(readFileSync(join(lab, "data", "outbox.jsonl"), "utf8"), OUTBOX, scenario);
    assert.equal(readFileSync(join(runDir, "crashed.marker"), "utf8"), `post-effect-fast pid=${out.pid}`, scenario);
    const [entry, ...rest] = readLedger(runDir);
    assert.equal(rest.length, 0, scenario);
    assert.equal(entry.endpoint, "APPEND data/outbox.jsonl", scenario);
    // The state was saved before the process died too.
    const state = JSON.parse(readFileSync(join(runDir, "provider-state.json"), "utf8")) as { fsWrites: Record<string, string> };
    assert.deepEqual(state.fsWrites, {}, scenario);
  }
});

test("post-effect-slow holds then kills after a file write", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-append", { env: { CT_CRASH_POINT: "post-effect-slow", CT_SLOW_HOLD_MS: "300" } });
  assert.notEqual(out.code, 0);
  assert.equal(printedAfter(out), false);
  assert.match(readFileSync(join(runDir, "crashed.marker"), "utf8"), /^post-effect-slow pid=\d+$/);
  const [entry, ...rest] = readLedger(runDir);
  assert.equal(rest.length, 0);
  assert.ok(out.exitedAt - Date.parse(entry.ts) >= 300 - TIMER_SLACK_MS, `died ${out.exitedAt - Date.parse(entry.ts)} ms after the write`);
});

test("the crash of a file write happens once, and the other crash points leave it alone", async (t) => {
  const lab = tempDir(t);
  const runDir = tempDir(t);
  const env = { CT_LAB_DIR: lab, CT_CRASH_POINT: "post-effect-fast" };
  const first = await runChild("fs-append", { runDir, cwd: lab, env });
  assert.equal(printedAfter(first), false);
  const second = await runChild("fs-append", { runDir, cwd: lab, env });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(printedAfter(second), true);
  assert.deepEqual(readLedger(runDir).map((e) => [e.seq, e.pid]), [[1, first.pid], [2, second.pid]]);
  assert.match(readFileSync(join(runDir, "crashed.marker"), "utf8"), new RegExp(`^post-effect-fast pid=${first.pid}$`));

  for (const point of ["none", "post-settle"]) {
    const calm = await runInLab(t, "fs-append", { env: { CT_CRASH_POINT: point } });
    assert.equal(calm.out.code, 0, calm.out.stderr);
    assert.equal(printedAfter(calm.out), true, point);
    assert.equal(existsSync(join(calm.runDir, "crashed.marker")), false, point);
  }
});

test("a file write that effects.ignore names never claims the crash: the crash follows the next effect", async (t) => {
  const { out, runDir } = await runInLab(t, "fs-build-then-append", { env: { CT_CRASH_POINT: "post-effect-fast", CT_EFFECTS_IGNORE: JSON.stringify([".next/*"]) } });
  assert.notEqual(out.code, 0);
  assert.equal(eventOf(out, "built")?.event, "built");
  assert.equal(printedAfter(out), false);
  assert.equal(readFileSync(join(runDir, "crashed.marker"), "utf8"), `post-effect-fast pid=${out.pid}`);
  assert.deepEqual(readLedger(runDir).map((e) => e.endpoint), ["WRITE .next/build-manifest.json", "APPEND data/outbox.jsonl"]);
});
