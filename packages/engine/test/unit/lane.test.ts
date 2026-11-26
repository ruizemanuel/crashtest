import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrashtestConfig } from "../../src/config.ts";
import type { RunCellOptions } from "../../src/driver/run-cell.ts";
import type { Lab } from "../../src/lab.ts";
import { runLane } from "../../src/lane.ts";
import type { CellId, LaneResult, RunSummary, ToolInfo } from "../../src/types.ts";
import { call, entry, summary } from "./builders.ts";

/** What the fake runner makes one run look like. */
type Outcome =
  | "effect" // a baseline with one effect
  | "none" // a baseline with no effect at all
  | "failed" // a baseline whose tool call failed
  | "clean" // a crash run with exactly the expected effect
  | "dup" // a crash run whose effect happened twice
  | "phantom" // a crash run whose effect happened once but the model got an error
  | "invalid"; // a crash run that timed out

const LAB: Lab = { appDir: "/app", outDir: "/app/.crashtest", labDir: "/app/.crashtest/lab", eveBin: "eve", eveVersion: "1.5.0" };

const SCHEMA = {
  type: "object",
  properties: { orderId: { type: "string" }, amount: { type: "number" }, text: { type: "string" } },
  required: ["orderId", "amount", "text"],
};
const NAIVE: ToolInfo = { name: "naive", file: "agent/tools/naive.ts", inputSchema: SCHEMA };

const BASELINES: CellId[] = ["baseline-1", "baseline-2"];
const CRASH: CellId[] = ["post-effect-fast-stable", "post-effect-fast-fresh", "post-effect-slow", "post-settle"];

/** One run the way the real runner would summarize it; the lane's analysis then judges it like any other. */
function runOf(o: RunCellOptions, outcome: Outcome, approvals = 0): RunSummary {
  const crash = o.cell.point !== "none";
  const base = {
    tool: o.tool.name,
    cellId: o.cell.id,
    attempt: o.attempt,
    crashPoint: o.cell.point,
    idMode: o.cell.idMode,
    latencyMs: o.cell.latencyMs,
    holdMs: o.cell.holdMs,
    approvals,
    ...(crash ? { marker: `${o.cell.point} pid=1`, serverDied: true, killedBy: "crash-point" as const, restarted: true } : {}),
  };
  switch (outcome) {
    case "effect":
    case "clean":
      return summary({ ...base, ledger: [entry()] });
    case "none":
      return summary({ ...base, ledger: [] });
    case "dup":
      return summary({ ...base, ledger: [entry(), entry()] });
    case "failed":
      return summary({ ...base, calls: [call({ tool: o.tool.name, outcome: "failed", error: { message: "boom" } })], ledger: [] });
    case "phantom":
      return summary({ ...base, calls: [call({ tool: o.tool.name, outcome: "failed", error: { message: "gateway timeout" } })], ledger: [entry()] });
    case "invalid":
      return summary({ ...base, turnOutcome: "timeout" });
  }
}

/**
 * A runner scripted per cell: the n-th run of a cell gets `script[cell][n - 1]`. Unscripted baselines have one
 * effect and unscripted crash cells are clean; any run beyond the script's end fails the test loudly.
 */
function fakeRunner(script: Partial<Record<CellId, Outcome[]>> = {}, approvals = 0) {
  const seen: RunCellOptions[] = [];
  const runner = async (o: RunCellOptions): Promise<RunSummary> => {
    seen.push(o);
    const planned = script[o.cell.id];
    const fallback: Outcome | undefined = o.attempt === 1 ? (o.cell.point === "none" ? "effect" : "clean") : undefined;
    const outcome = planned?.[o.attempt - 1] ?? fallback;
    assert.ok(outcome !== undefined, `unexpected run of ${o.cell.id} attempt ${o.attempt}`);
    return runOf(o, outcome, approvals);
  };
  return { runner, seen, ids: () => seen.map((o) => o.cell.id), attemptsOf: (id: CellId) => seen.filter((o) => o.cell.id === id).map((o) => o.attempt) };
}

function lane(fake: ReturnType<typeof fakeRunner>, extra: { config?: CrashtestConfig; tool?: ToolInfo; onProgress?: (line: string) => void } = {}): Promise<LaneResult> {
  return runLane({ lab: LAB, tool: extra.tool ?? NAIVE, config: extra.config ?? {}, runner: fake.runner, ...(extra.onProgress ? { onProgress: extra.onProgress } : {}) });
}

function verdictOf(result: LaneResult, id: CellId) {
  const found = result.rating.cells.find((cell) => cell.cellId === id);
  assert.ok(found, `no verdict for ${id}`);
  return found;
}

// --- the common cases ------------------------------------------------------------------------------------------

test("a clean tool runs two baselines and four crash cells once each and rates 5 stars", async () => {
  const fake = fakeRunner();
  const result = await lane(fake);
  assert.deepEqual(fake.ids(), [...BASELINES, ...CRASH]);
  assert.equal(result.tool, "naive");
  assert.equal(result.runs, 6);
  assert.equal(result.rating.stars, 5);
  assert.deepEqual(result.rating.cells.map((cell) => cell.cellId), CRASH);
  for (const cell of result.rating.cells) {
    assert.equal(cell.kind, "clean");
    assert.equal(cell.attempts, 1);
    assert.equal(cell.seen, undefined);
  }
  assert.ok(result.wallMs >= 0);
});

test("a baseline with no effect is N/E after exactly two runs", async () => {
  const fake = fakeRunner({ "baseline-1": ["none"], "baseline-2": ["none"] });
  const result = await lane(fake);
  assert.deepEqual(fake.ids(), BASELINES);
  assert.equal(result.runs, 2);
  assert.equal(result.rating.stars, null);
  assert.equal(result.rating.na?.reason, "no-effect");
  assert.deepEqual(result.rating.cells, []);
});

test("baselines that disagree are N/E (unstable) and no crash cell runs", async () => {
  const fake = fakeRunner({ "baseline-2": ["none"] });
  const result = await lane(fake);
  assert.equal(result.runs, 2);
  assert.equal(result.rating.na?.reason, "baseline-unstable");
});

test("a failing baseline is N/E with the scenarios hint and no crash cell runs", async () => {
  const fake = fakeRunner({ "baseline-1": ["failed"] });
  const result = await lane(fake);
  assert.deepEqual(fake.ids(), BASELINES);
  assert.equal(result.runs, 2);
  assert.equal(result.rating.stars, null);
  assert.equal(result.rating.na?.reason, "baseline-failed");
  assert.match(result.rating.na?.detail ?? "", /boom/);
  assert.match(result.rating.na?.detail ?? "", /scenarios\.naive\.input/);
  assert.match(result.rating.summary, /scenarios\.naive\.input/);
});

test("a not-evaluable tool keeps the approval flag, identity and waiver", async () => {
  const fake = fakeRunner({ "baseline-1": ["failed"] }, 1);
  const result = await lane(fake, { config: { waivers: { naive: "tracked in TICKET-1" } } });
  assert.equal(result.rating.approval, true);
  assert.deepEqual(result.rating.identity, ["orderId", "amount"]);
  assert.equal(result.rating.waived, "tracked in TICKET-1");
});

// --- confirming a non-clean verdict ----------------------------------------------------------------------------

test("a duplicate seen twice in a row is confirmed after two runs", async () => {
  const fake = fakeRunner({ "post-effect-fast-stable": ["dup", "dup"] });
  const result = await lane(fake);
  assert.equal(result.runs, 7);
  assert.deepEqual(fake.attemptsOf("post-effect-fast-stable"), [1, 2]);
  const v = verdictOf(result, "post-effect-fast-stable");
  assert.equal(v.kind, "dup");
  assert.equal(v.dupClass, "stable");
  assert.equal(v.attempts, 2);
  assert.equal(v.seen, "2 of 2");
  assert.equal(result.rating.stars, 1);
  assert.equal(verdictOf(result, "post-settle").seen, undefined);
});

test("dup, clean, dup is a duplicate seen 2 of 3", async () => {
  const fake = fakeRunner({ "post-effect-fast-stable": ["dup", "clean", "dup"] });
  const result = await lane(fake);
  assert.equal(result.runs, 8);
  assert.deepEqual(fake.attemptsOf("post-effect-fast-stable"), [1, 2, 3]);
  const v = verdictOf(result, "post-effect-fast-stable");
  assert.equal(v.kind, "dup");
  assert.equal(v.attempts, 3);
  assert.equal(v.seen, "2 of 3");
  assert.equal(result.rating.stars, 1);
});

test("dup, clean, clean is clean and records that the duplicate was seen 1 of 3", async () => {
  const fake = fakeRunner({ "post-effect-fast-stable": ["dup", "clean", "clean"] });
  const result = await lane(fake);
  assert.equal(result.runs, 8);
  const v = verdictOf(result, "post-effect-fast-stable");
  assert.equal(v.kind, "clean");
  assert.equal(v.attempts, 3);
  assert.equal(v.seen, "1 of 3");
  assert.equal(v.stateChanges, 1);
  assert.equal(result.rating.stars, 5);
});

test("two different non-clean verdicts followed by a repeat of the second is confirmed as the second", async () => {
  const fake = fakeRunner({ "post-settle": ["dup", "phantom", "phantom"] });
  const result = await lane(fake);
  const v = verdictOf(result, "post-settle");
  assert.equal(v.kind, "phantom-failure");
  assert.equal(v.attempts, 3);
  assert.equal(v.seen, "2 of 3");
  assert.equal(result.rating.stars, 4);
});

test("three different verdicts with a clean one among them are clean, seen 1 of 3", async () => {
  const fake = fakeRunner({ "post-settle": ["dup", "phantom", "clean"] });
  const result = await lane(fake);
  const v = verdictOf(result, "post-settle");
  assert.equal(v.kind, "clean");
  assert.equal(v.seen, "1 of 3");
  assert.equal(v.attempts, 3);
});

test("three different verdicts and none clean cannot be confirmed: the cell is invalid", async () => {
  const fake = fakeRunner({ "post-settle": ["dup", "invalid", "phantom"] });
  const result = await lane(fake);
  const v = verdictOf(result, "post-settle");
  assert.equal(v.kind, "invalid");
  assert.equal(v.invalidReason, "unconfirmed: dup, invalid, phantom-failure");
  assert.equal(v.attempts, 3);
  assert.equal(result.rating.stars, null);
  assert.equal(result.rating.na?.reason, "cells-invalid");
});

// --- invalid cells ---------------------------------------------------------------------------------------------

test("an invalid run is retried once and a clean retry stands", async () => {
  const fake = fakeRunner({ "post-effect-slow": ["invalid", "clean"] });
  const result = await lane(fake);
  assert.equal(result.runs, 7);
  assert.deepEqual(fake.attemptsOf("post-effect-slow"), [1, 2]);
  const v = verdictOf(result, "post-effect-slow");
  assert.equal(v.kind, "clean");
  assert.equal(v.attempts, 2);
  assert.equal(v.seen, undefined);
  assert.equal(result.rating.stars, 5);
});

test("a cell invalid twice makes the tool N/E (cells-invalid) while the other cells still run", async () => {
  const fake = fakeRunner({ "post-effect-slow": ["invalid", "invalid"] });
  const result = await lane(fake);
  assert.equal(result.runs, 7);
  assert.deepEqual(fake.ids().slice(-1), ["post-settle"]);
  const v = verdictOf(result, "post-effect-slow");
  assert.equal(v.kind, "invalid");
  assert.equal(v.attempts, 2);
  assert.equal(result.rating.stars, null);
  assert.equal(result.rating.na?.reason, "cells-invalid");
  assert.match(result.rating.na?.detail ?? "", /post-effect-slow/);
});

test("an invalid first run followed by a duplicate is confirmed from the duplicate, seen out of the judged runs", async () => {
  const fake = fakeRunner({ "post-effect-fast-fresh": ["invalid", "dup", "dup"] });
  const result = await lane(fake);
  const v = verdictOf(result, "post-effect-fast-fresh");
  assert.equal(v.kind, "dup");
  assert.equal(v.dupClass, "fresh");
  assert.equal(v.attempts, 3);
  assert.equal(v.seen, "2 of 2");
  assert.equal(result.rating.stars, 3);
});

// --- what reaches the runner -----------------------------------------------------------------------------------

test("the configured scenario input and free text reach every run", async () => {
  const fake = fakeRunner();
  const input = { orderId: "ord_7", amount: 12, text: "hello" };
  // A free-text list that differs from the one derived from the schema (["text"]), so ignoring the config fails.
  const result = await lane(fake, { config: { scenarios: { naive: { input, freeText: ["orderId"] } } } });
  assert.equal(fake.seen.length, 6);
  for (const o of fake.seen) {
    assert.deepEqual(o.input, input);
    assert.deepEqual(o.freeTextFields, ["orderId"]);
    assert.equal(o.lab, LAB);
    assert.equal(o.tool, NAIVE);
  }
  // The configured free text also decides which fields count as the identity of a call.
  assert.deepEqual(result.rating.identity, ["amount", "text"]);
});

test("without a scenario the input comes from the schema and free text from the field names", async () => {
  const fake = fakeRunner();
  const result = await lane(fake);
  for (const o of fake.seen) {
    assert.deepEqual(o.input, { orderId: "orderId_ct_1", amount: 1, text: "crashtest text" });
    assert.deepEqual(o.freeTextFields, ["text"]);
  }
  assert.deepEqual(result.rating.identity, ["orderId", "amount"]);
});

test("a scenario of another tool does not apply", async () => {
  const fake = fakeRunner();
  await lane(fake, { config: { scenarios: { other: { input: { orderId: "x" }, freeText: [] } } } });
  assert.deepEqual(fake.seen[0]?.freeTextFields, ["text"]);
});

test("configured identity and waiver reach the rating; the config reaches the runner", async () => {
  const fake = fakeRunner();
  const config: CrashtestConfig = { identity: { naive: ["orderId"] }, waivers: { naive: "accepted risk" }, effects: { ignore: ["https://x/*"] } };
  const result = await lane(fake, { config });
  assert.deepEqual(result.rating.identity, ["orderId"]);
  assert.equal(result.rating.waived, "accepted risk");
  for (const o of fake.seen) assert.equal(o.config, config);
});

test("attempts count up per cell, starting at 1", async () => {
  const fake = fakeRunner({ "post-effect-fast-stable": ["invalid", "dup", "clean", "dup"] });
  await lane(fake);
  assert.deepEqual(fake.attemptsOf("baseline-1"), [1]);
  assert.deepEqual(fake.attemptsOf("post-effect-fast-stable"), [1, 2, 3, 4]);
});

test("the approval flag comes from the first baseline", async () => {
  const fake = fakeRunner({ "post-effect-fast-stable": ["dup", "dup"] }, 1);
  const result = await lane(fake);
  assert.equal(result.rating.approval, true);
  assert.equal(result.rating.stars, 2);
});

// --- progress --------------------------------------------------------------------------------------------------

test("every run reports a progress line with its label, verdict, effects and seconds", async () => {
  const lines: string[] = [];
  const fake = fakeRunner({ "post-effect-fast-stable": ["dup", "dup"] });
  await lane(fake, { onProgress: (line) => lines.push(line) });
  assert.deepEqual(lines, [
    "[crashtest] naive baseline 1 -> completed (1 effects, 1.0s)",
    "[crashtest] naive baseline 2 -> completed (1 effects, 1.0s)",
    "[crashtest] naive post-effect-fast (stable id) -> dup (2/1 effects, 1.0s)",
    "[crashtest] naive post-effect-fast (stable id) -> dup (2/1 effects, 1.0s)",
    "[crashtest] naive post-effect-fast (fresh id) -> clean (1/1 effects, 1.0s)",
    "[crashtest] naive post-effect-slow + retry -> clean (1/1 effects, 1.0s)",
    "[crashtest] naive post-settle (2.5 s latency) -> clean (1/1 effects, 1.0s)",
  ]);
});

test("progress labels use the approval wording for a tool that needs approval", async () => {
  const lines: string[] = [];
  await lane(fakeRunner({}, 1), { onProgress: (line) => lines.push(line) });
  assert.ok(lines.some((line) => line.startsWith("[crashtest] naive approved-post-effect -> ")), lines.join("\n"));
});

test("onProgress is passed on to the runner", async () => {
  const lines: string[] = [];
  const fake = fakeRunner();
  await lane(fake, { onProgress: (line) => lines.push(line) });
  assert.ok(fake.seen.every((o) => typeof o.onProgress === "function"));
});

test("without onProgress the runner gets none either", async () => {
  const fake = fakeRunner();
  await lane(fake);
  assert.ok(fake.seen.every((o) => o.onProgress === undefined));
});
