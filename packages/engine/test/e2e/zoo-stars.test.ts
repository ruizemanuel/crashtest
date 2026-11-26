import assert from "node:assert/strict";
import { before, test, type TestContext } from "node:test";
import type { Discovery } from "../../src/discover.ts";
import type { Lab } from "../../src/lab.ts";
import { runLane } from "../../src/lane.ts";
import type { LaneResult } from "../../src/types.ts";
import { prepareLab, tool, zooDir } from "./helpers.ts";

// The regression contract of the zoo: every tool's expected rating, each from a real lane (two baselines, four
// crash cells and their confirmations, every one a full `eve dev` life). All the tools share one lab.
const E2E = { timeout: 900_000 };

let shared: { lab: Lab; discovery: Discovery };

before(async () => {
  shared = await prepareLab(zooDir);
}, { timeout: 300_000 });

async function lane(t: TestContext, name: string): Promise<{ result: LaneResult; detail: string }> {
  const result = await runLane({ lab: shared.lab, tool: tool(shared.discovery, name), config: {}, onProgress: (line) => t.diagnostic(line) });
  const { rating } = result;
  for (const cell of rating.cells) {
    t.diagnostic(`${cell.cellId}: ${cell.kind}${cell.dupClass ? ` (${cell.dupClass})` : ""}, outcome ${cell.outcome}, ${cell.stateChanges}/${cell.expected} effects, ${cell.benignRepeats} benign, attempts ${cell.attempts}${cell.seen ? `, seen ${cell.seen}` : ""}`);
  }
  const verdict = rating.stars === null ? `N/E (${rating.na?.reason})` : `${rating.stars} stars`;
  t.diagnostic(`${name}: ${verdict} in ${result.runs} runs, ${(result.wallMs / 1000).toFixed(1)} s`);
  assert.equal(result.tool, name);
  return { result, detail: JSON.stringify(rating) };
}

test("zoo: smoke: naive rates 1 star", E2E, async (t) => {
  const { result, detail } = await lane(t, "naive");
  assert.equal(result.rating.stars, 1, detail);
});

test("zoo: fs_effect rates 1 star, its effect being a file write", E2E, async (t) => {
  const { result, detail } = await lane(t, "fs_effect");
  assert.equal(result.rating.stars, 1, detail);
  // The effect is counted through the same ledger as an HTTP request.
  const endpoints = new Set(result.rating.cells.flatMap((cell) => cell.evidence.map((item) => item.endpoint)));
  assert.deepEqual([...endpoints], ["APPEND data/outbox.jsonl"], detail);
});

test("zoo: approval_naive rates 2 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "approval_naive");
  assert.equal(result.rating.stars, 2, detail);
});

test("zoo: callid_guard rates 3 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "callid_guard");
  assert.equal(result.rating.stars, 3, detail);
});

test("zoo: phantom_failure rates 4 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "phantom_failure");
  assert.equal(result.rating.stars, 4, detail);
});

test("zoo: smoke: opkey_guard rates 5 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "opkey_guard");
  assert.equal(result.rating.stars, 5, detail);
});

test("zoo: upstream_key rates 5 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "upstream_key");
  assert.equal(result.rating.stars, 5, detail);
});

test("zoo: benign_labels rates 5 stars with benign repeats", E2E, async (t) => {
  const { result, detail } = await lane(t, "benign_labels");
  assert.equal(result.rating.stars, 5, detail);
  assert.equal(result.rating.benignRepeats, true, detail);
});

test("zoo: check_before_act rates 5 stars", E2E, async (t) => {
  const { result, detail } = await lane(t, "check_before_act");
  assert.equal(result.rating.stars, 5, detail);
});

test("zoo: readonly is not evaluable for lack of an effect", E2E, async (t) => {
  const { result, detail } = await lane(t, "readonly");
  assert.equal(result.rating.stars, null, detail);
  assert.equal(result.rating.na?.reason, "no-effect", detail);
});
