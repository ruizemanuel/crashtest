import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test, type TestContext } from "node:test";
import type { Discovery } from "../../src/discover.ts";
import { listenerPids } from "../../src/driver/ports.ts";
import { runCell, runDirFor, type RunCellOptions } from "../../src/driver/run-cell.ts";
import { freeTextFields, sampleInput } from "../../src/inputs.ts";
import type { Lab } from "../../src/lab.ts";
import type { Cell, CellId, LedgerEntry, RunSummary } from "../../src/types.ts";
import { prepareLab, tool, zooDir } from "./helpers.ts";

const E2E = { timeout: 900_000 };

const CELLS: Record<CellId, Cell> = {
  "baseline-1": { id: "baseline-1", point: "none", idMode: "stable", latencyMs: 0, holdMs: 0 },
  "baseline-2": { id: "baseline-2", point: "none", idMode: "stable", latencyMs: 0, holdMs: 0 },
  "post-effect-fast-stable": { id: "post-effect-fast-stable", point: "post-effect-fast", idMode: "stable", latencyMs: 0, holdMs: 0 },
  "post-effect-fast-fresh": { id: "post-effect-fast-fresh", point: "post-effect-fast", idMode: "fresh", latencyMs: 0, holdMs: 0 },
  "post-effect-slow": { id: "post-effect-slow", point: "post-effect-slow", idMode: "fresh", latencyMs: 0, holdMs: 2000 },
  "post-settle": { id: "post-settle", point: "post-settle", idMode: "stable", latencyMs: 2500, holdMs: 0 },
};

let zoo: { lab: Lab; discovery: Discovery };

before(async () => {
  zoo = await prepareLab(zooDir);
});

/** Runs one cell of `toolName` with the tool's generated input and checks the cleanup every cell must leave behind. */
async function run(
  t: TestContext,
  toolName: string,
  cellId: CellId,
  extra: Partial<RunCellOptions> & { on?: { lab: Lab; discovery: Discovery } } = {},
): Promise<RunSummary> {
  const { on = zoo, ...overrides } = extra;
  const info = tool(on.discovery, toolName);
  const summary = await runCell({
    lab: on.lab,
    tool: info,
    cell: CELLS[cellId],
    attempt: 1,
    input: sampleInput(info.inputSchema),
    freeTextFields: freeTextFields(info.inputSchema),
    config: {},
    onProgress: (line) => t.diagnostic(line),
    ...overrides,
  });
  t.diagnostic(`${toolName} ${cellId}: ${summary.turnOutcome} in ${summary.wallMs} ms, summary ${join(summary.runDir, "summary.json")}`);

  // Self-identifying evidence, also on disk.
  assert.equal(summary.tool, toolName);
  assert.equal(summary.cellId, cellId);
  assert.equal(summary.crashPoint, CELLS[cellId].point);
  assert.equal(summary.idMode, CELLS[cellId].idMode);
  assert.equal(summary.latencyMs, CELLS[cellId].latencyMs);
  assert.equal(summary.holdMs, CELLS[cellId].holdMs);
  assert.equal(summary.eveVersion, "1.5.0");
  assert.equal(summary.runDir, runDirFor(on.lab, toolName, cellId, summary.attempt));
  assert.deepEqual(JSON.parse(readFileSync(join(summary.runDir, "summary.json"), "utf8")), summary);

  // Nothing of the run is left listening.
  assert.deepEqual(listenerPids(summary.port), [], `nothing listens on port ${summary.port} after the run`);
  return summary;
}

function effects(summary: RunSummary): LedgerEntry[] {
  return summary.ledger.filter((entry) => entry.mutating && entry.stateChange);
}

function body(entry: LedgerEntry | undefined): Record<string, unknown> {
  assert.ok(entry && typeof entry.body === "object" && entry.body !== null, `ledger entry has a JSON body: ${JSON.stringify(entry)}`);
  return entry.body as Record<string, unknown>;
}

/** The non-empty string at `key` of the entry's body: a missing id must never compare equal to another missing id. */
function field(entry: LedgerEntry | undefined, key: string): string {
  const value = body(entry)[key];
  assert.equal(typeof value, "string", `body.${key} is a string: ${JSON.stringify(entry?.body)}`);
  assert.match(value as string, /\S/, `body.${key} is not empty`);
  return value as string;
}

function describe(summary: RunSummary): string {
  const { ledger, calls, ...rest } = summary;
  return JSON.stringify({ ...rest, calls, ledger: ledger.map((e) => ({ endpoint: e.endpoint, stateChange: e.stateChange, body: e.body })) });
}

test("smoke: baseline naive", E2E, async (t) => {
  const s = await run(t, "naive", "baseline-1");
  assert.equal(s.turnOutcome, "completed", describe(s));
  assert.equal(s.preloadReady, true);
  assert.equal(s.serverDied, false);
  assert.equal(s.killedBy, null);
  assert.equal(s.restarted, false);
  assert.equal(s.marker, null);
  assert.match(s.sessionId ?? "", /\S/);
  assert.equal(effects(s).length, 1, describe(s));
  assert.equal(s.calls.filter((c) => c.tool === "naive" && c.outcome === "completed").length, 1, describe(s));
  assert.ok(existsSync(join(s.runDir, "summary.json")));
});

test("smoke: post-effect-fast stable replays with the same call id", E2E, async (t) => {
  const s = await run(t, "naive", "post-effect-fast-stable");
  assert.equal(s.serverDied, true, describe(s));
  assert.equal(s.killedBy, "crash-point");
  assert.match(s.marker ?? "", /^post-effect-fast pid=\d+$/);
  assert.equal(s.restarted, true);
  assert.equal(s.turnOutcome, "completed", describe(s));
  const fx = effects(s);
  assert.equal(fx.length, 2, describe(s));
  // Design fact: eve replays the interrupted step with the call id it derived the first time.
  assert.equal(field(fx[0], "callId"), field(fx[1], "callId"), describe(s));
});

test("post-effect-fast fresh: new id, rewritten text, same identity", E2E, async (t) => {
  const s = await run(t, "naive", "post-effect-fast-fresh");
  assert.equal(s.serverDied, true, describe(s));
  assert.equal(s.killedBy, "crash-point");
  assert.equal(s.turnOutcome, "completed", describe(s));
  const fx = effects(s);
  assert.equal(fx.length, 2, describe(s));
  assert.notEqual(field(fx[0], "callId"), field(fx[1], "callId"), describe(s));
  assert.ok(field(fx[1], "text").endsWith("(rewritten 2)"), describe(s));
  assert.equal(field(fx[0], "orderId"), field(fx[1], "orderId"));
});

test("post-effect-slow: abandoned call, model retry in the same turn", E2E, async (t) => {
  const s = await run(t, "naive", "post-effect-slow");
  assert.equal(s.serverDied, true, describe(s));
  assert.equal(s.killedBy, "crash-point");
  assert.equal(s.turnOutcome, "completed", describe(s));
  assert.ok(s.calls.some((c) => c.tool === "naive" && c.outcome === "abandoned"), describe(s));
  const fx = effects(s);
  assert.equal(fx.length, 2, describe(s));
  assert.notEqual(field(fx[0], "callId"), field(fx[1], "callId"), describe(s));
  // Design fact: the op-key uses the turn id, so the model's retry must run in the same turn.
  assert.equal(field(fx[0], "turnId"), field(fx[1], "turnId"), describe(s));
});

test("post-settle on readonly: framework startup creates no effects", E2E, async (t) => {
  const s = await run(t, "readonly", "post-settle");
  assert.equal(s.latencyMs, 2500);
  assert.equal(s.serverDied, true, describe(s));
  assert.equal(s.killedBy, "crash-point");
  assert.match(s.marker ?? "", /^post-settle pid=\d+$/, "the probe hook made the crash");
  assert.equal(s.turnOutcome, "completed", describe(s));
  assert.ok(s.ledger.length >= 1, `the tool's lookup reached the fake provider: ${describe(s)}`);
  assert.equal(s.ledger.filter((entry) => entry.mutating).length, 0, describe(s));
  assert.equal(s.ledger.filter((entry) => entry.kind === "fs").length, 0, `eve writes nothing outside .eve in the lab: ${describe(s)}`);
});

test("fs_effect: the replay after a crash appends the outbox line twice, and both appends are effects", E2E, async (t) => {
  const s = await run(t, "fs_effect", "post-effect-fast-stable");
  assert.equal(s.serverDied, true, describe(s));
  assert.equal(s.killedBy, "crash-point");
  assert.match(s.marker ?? "", /^post-effect-fast pid=\d+$/);
  assert.equal(s.restarted, true);
  assert.equal(s.turnOutcome, "completed", describe(s));
  // The tool's code imports node:fs on its own, and its writes are observed all the same.
  const fx = effects(s);
  assert.equal(fx.length, 2, describe(s));
  assert.deepEqual(fx.map((entry) => [entry.kind, entry.endpoint, entry.url]), [["fs", "APPEND data/outbox.jsonl", "data/outbox.jsonl"], ["fs", "APPEND data/outbox.jsonl", "data/outbox.jsonl"]]);
  assert.notEqual(fx[0].pid, fx[1].pid, "the two appends come from two processes");
  assert.equal(s.ledger.filter((entry) => entry.kind === "fs").length, 2, `eve writes nothing else in the lab outside .eve: ${describe(s)}`);
  const input = sampleInput(tool(zoo.discovery, "fs_effect").inputSchema);
  assert.deepEqual(fx.map((entry) => entry.body), [input, input], describe(s));
  // The next cell starts from the prepared lab files: what the tool wrote, and the directory it made, are gone.
  assert.equal(existsSync(join(zoo.lab.labDir, "data", "outbox.jsonl")), false);
  assert.equal(existsSync(join(zoo.lab.labDir, "data")), false);
  assert.equal(s.error, undefined, describe(s));
});

test("baseline approval_naive is auto-approved", E2E, async (t) => {
  const s = await run(t, "approval_naive", "baseline-1");
  assert.ok(s.approvals >= 1, describe(s));
  assert.equal(effects(s).length, 1, describe(s));
  assert.equal(s.turnOutcome, "completed", describe(s));
});

test("lab and run dir with spaces", E2E, async (t) => {
  const spaced = await prepareLab(zooDir, { outDir: join(zooDir, ".crashtest", "out space") });
  assert.match(spaced.lab.labDir, / /);
  const s = await run(t, "naive", "baseline-1", { on: spaced });
  assert.match(s.runDir, /out space/);
  assert.equal(s.preloadReady, true, describe(s));
  assert.equal(effects(s).length, 1, describe(s));
  assert.equal(s.turnOutcome, "completed", describe(s));
});

test("existing NODE_OPTIONS is kept", E2E, async (t) => {
  // Attempt 2 keeps the smoke baseline's run directory intact.
  const s = await run(t, "naive", "baseline-1", { attempt: 2, baseEnv: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" } });
  assert.equal(s.preloadReady, true, describe(s));
  assert.equal(effects(s).length, 1, describe(s));
  assert.equal(s.turnOutcome, "completed", describe(s));
});
