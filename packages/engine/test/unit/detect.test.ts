import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCell, baselineFacts } from "../../src/detect.ts";
import { CORE_CELLS, cellLabel, crashCells } from "../../src/matrix.ts";
import type { Cell, CellId } from "../../src/types.ts";
import { REFUNDS, REFUNDS_URL, call, catalogEntry, entry, summary } from "./builders.ts";

function cellOf(id: CellId): Cell {
  const cell = CORE_CELLS.find((candidate) => candidate.id === id);
  assert.ok(cell, `no core cell ${id}`);
  return cell;
}

const ONE_REFUND = { expected: { [REFUNDS]: 1 }, volatileFields: [] as string[] };

/** A crash-cell run that reached its crash point (marker set, killed by the crash point). */
function crashRun(partial: Parameters<typeof summary>[0] = {}): ReturnType<typeof summary> {
  return summary({ cellId: "post-effect-fast-stable", crashPoint: "post-effect-fast", marker: "crash-1", serverDied: true, killedBy: "crash-point", restarted: true, ...partial });
}

// --- matrix ---------------------------------------------------------------------------------------------------

test("CORE_CELLS lists two baselines and four crash cells with their settings", () => {
  assert.deepEqual(
    CORE_CELLS.map((cell) => [cell.id, cell.point, cell.idMode, cell.latencyMs, cell.holdMs]),
    [
      ["baseline-1", "none", "stable", 0, 0],
      ["baseline-2", "none", "stable", 0, 0],
      ["post-effect-fast-stable", "post-effect-fast", "stable", 0, 0],
      ["post-effect-fast-fresh", "post-effect-fast", "fresh", 0, 0],
      ["post-effect-slow", "post-effect-slow", "fresh", 0, 2000],
      ["post-settle", "post-settle", "stable", 2500, 0],
    ],
  );
  assert.deepEqual(crashCells().map((cell) => cell.id), ["post-effect-fast-stable", "post-effect-fast-fresh", "post-effect-slow", "post-settle"]);
});

test("cellLabel names each cell for the report", () => {
  assert.equal(cellLabel("post-effect-fast-stable", false), "post-effect-fast (stable id)");
  assert.equal(cellLabel("post-effect-fast-stable", true), "approved-post-effect");
  assert.equal(cellLabel("post-effect-fast-fresh", false), "post-effect-fast (fresh id)");
  assert.equal(cellLabel("post-effect-fast-fresh", true), "post-effect-fast (fresh id)");
  assert.equal(cellLabel("post-effect-slow", false), "post-effect-slow + retry");
  assert.equal(cellLabel("post-settle", false), "post-settle (2.5 s latency)");
});

// --- analyzeCell: invalid cells -------------------------------------------------------------------------------

test("analyzeCell marks a run without the preload as invalid (preload-missing)", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ preloadReady: false }), ONE_REFUND, {});
  assert.equal(v.kind, "invalid");
  assert.equal(v.invalidReason, "preload-missing");
  assert.equal(v.attempts, 1);
});

test("analyzeCell marks a turn that did not complete as invalid (turn-<outcome>)", () => {
  for (const outcome of ["failed", "cancelled", "timeout", "startup-failed", "died-after-resume", "stream-failed"]) {
    const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ turnOutcome: outcome }), ONE_REFUND, {});
    assert.equal(v.kind, "invalid");
    assert.equal(v.invalidReason, `turn-${outcome}`);
  }
});

test("analyzeCell marks a crash cell without a marker as invalid (crash-not-triggered)", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ marker: null, serverDied: false, killedBy: null }), ONE_REFUND, {});
  assert.equal(v.kind, "invalid");
  assert.equal(v.invalidReason, "crash-not-triggered");
});

test("analyzeCell does not require a marker on a baseline cell", () => {
  const v = analyzeCell(cellOf("baseline-1"), summary({ ledger: [entry()] }), ONE_REFUND, {});
  assert.equal(v.kind, "clean");
});

test("analyzeCell marks harness and unexpected kills as invalid", () => {
  const harness = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ killedBy: "harness" }), ONE_REFUND, {});
  assert.equal(harness.kind, "invalid");
  assert.equal(harness.invalidReason, "harness-kill");
  const unexpected = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ killedBy: "unexpected" }), ONE_REFUND, {});
  assert.equal(unexpected.kind, "invalid");
  assert.equal(unexpected.invalidReason, "unexpected-death");
});

test("analyzeCell marks a run without any call to the tool as invalid (no-call)", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls: [call({ tool: "other" })] }), ONE_REFUND, {});
  assert.equal(v.kind, "invalid");
  assert.equal(v.invalidReason, "no-call");
  const none = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls: [] }), ONE_REFUND, {});
  assert.equal(none.invalidReason, "no-call");
});

test("analyzeCell applies the invalid rules in the stated order", () => {
  const run = crashRun({ preloadReady: false, turnOutcome: "timeout", marker: null, killedBy: "harness", calls: [] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, {}).invalidReason, "preload-missing");
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), { ...run, preloadReady: true }, ONE_REFUND, {}).invalidReason, "turn-timeout");
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), { ...run, preloadReady: true, turnOutcome: "completed" }, ONE_REFUND, {}).invalidReason, "crash-not-triggered");
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), { ...run, preloadReady: true, turnOutcome: "completed", marker: "m" }, ONE_REFUND, {}).invalidReason, "harness-kill");
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), { ...run, preloadReady: true, turnOutcome: "completed", marker: "m", killedBy: "crash-point" }, ONE_REFUND, {}).invalidReason, "no-call");
});

// --- analyzeCell: recovery and outcome ------------------------------------------------------------------------

test("analyzeCell reports recovery none, replayed and interrupted", () => {
  assert.equal(analyzeCell(cellOf("baseline-1"), summary({ ledger: [entry()] }), ONE_REFUND, {}).recovery, "none");
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry()] }), ONE_REFUND, {}).recovery, "replayed");
  const abandoned = crashRun({ calls: [call({ outcome: "abandoned" }), call({ callId: "call_2" })], ledger: [entry()] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), abandoned, ONE_REFUND, {}).recovery, "interrupted");
});

test("analyzeCell maps the last settled call to an outcome", () => {
  const verdictFor = (calls: ReturnType<typeof call>[]) => analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls, ledger: [entry()] }), ONE_REFUND, {});

  assert.equal(verdictFor([call()]).outcome, "success");
  assert.equal(verdictFor([call({ outcome: "failed", error: "OUTCOME_UNKNOWN: refund may have happened" })]).outcome, "uncertain");
  assert.equal(verdictFor([call({ outcome: "failed", error: { message: "TOOL_RECOVERY_REQUIRED" } })]).outcome, "uncertain");
  assert.equal(verdictFor([call({ outcome: "failed", error: { code: "OUTCOME_UNKNOWN", message: "unclear" } })]).outcome, "uncertain");
  assert.equal(verdictFor([call({ outcome: "abandoned" })]).outcome, "abandoned");
  assert.equal(verdictFor([call({ outcome: "requested" })]).outcome, "missing");
});

test("analyzeCell stores the message of a generic failure as the error", () => {
  const verdictFor = (error: unknown) => analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls: [call({ outcome: "failed", error })], ledger: [entry()] }), ONE_REFUND, {});

  const text = verdictFor("Stripe error 500");
  assert.equal(text.outcome, "error");
  assert.equal(text.error, "Stripe error 500");
  assert.equal(verdictFor({ message: "boom", code: 7 }).error, "boom");
  assert.equal(verdictFor({ code: 7 }).error, '{"code":7}');
});

test("analyzeCell does not store an error for an uncertain or successful call", () => {
  const uncertain = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls: [call({ outcome: "failed", error: "OUTCOME_UNKNOWN" })], ledger: [entry()] }), ONE_REFUND, {});
  assert.equal("error" in uncertain, false);
});

test("analyzeCell takes the outcome from the last settled call, skipping unsettled ones", () => {
  const calls = [call({ callId: "a", outcome: "failed", error: "first try failed" }), call({ callId: "b" }), call({ callId: "c", outcome: "requested" })];
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ calls, ledger: [entry()] }), ONE_REFUND, {});
  assert.equal(v.outcome, "success");
});

// --- analyzeCell: effects and kinds ---------------------------------------------------------------------------

test("analyzeCell is clean for exactly one state change and a truthful result", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [catalogEntry(), entry()] }), ONE_REFUND, {});
  assert.equal(v.kind, "clean");
  assert.equal(v.stateChanges, 1);
  assert.equal(v.expected, 1);
  assert.equal(v.benignRepeats, 0);
  assert.equal(v.attempts, 1);
  assert.deepEqual(v.evidence, [{ endpoint: REFUNDS, count: 1, expected: 1, diffFields: [] }]);
});

test("analyzeCell ignores non-mutating traffic and entries that are not state changes", () => {
  const ledger = [catalogEntry(), entry(), entry({ stateChange: false, benign: "idempotency key reused" }), entry({ method: "GET", endpoint: "GET api.stripe.com/v1/refunds", mutating: false, stateChange: false })];
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger }), ONE_REFUND, {});
  assert.equal(v.kind, "clean");
  assert.equal(v.stateChanges, 1);
  assert.equal(v.benignRepeats, 1);
});

test("analyzeCell counts benign repeats only among mutating entries", () => {
  const ledger = [entry(), entry({ stateChange: false, benign: "labels already present" }), entry({ mutating: false, stateChange: false, benign: "read" })];
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger }), ONE_REFUND, {});
  assert.equal(v.benignRepeats, 1);
  assert.equal(v.kind, "clean");
});

test("analyzeCell names the hosts outside the catalog whose key replays it counted as benign", () => {
  const acme = { url: "https://api.acme.test:8443/v1/m", endpoint: "POST api.acme.test:8443/v1/m" };
  const base = { expected: { [REFUNDS]: 1, [acme.endpoint]: 1 }, volatileFields: [] as string[] };
  const replay = { stateChange: false, benign: "idempotency key replay", idempotencyKey: "k1" };
  const ledger = [entry(), entry(replay), entry(acme), entry({ ...acme, ...replay }), entry({ ...acme, ...replay })];
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger }), base, {});
  assert.equal(v.kind, "clean");
  assert.equal(v.benignRepeats, 3);
  // Stripe honors the key for real; the other host is only assumed to.
  assert.deepEqual(v.assumedKeyHosts, ["api.acme.test:8443"]);

  const stripeOnly = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry(), entry(replay)] }), ONE_REFUND, {});
  assert.equal("assumedKeyHosts" in stripeOnly, false);
  // Another benign repeat on such a host rests on no assumption.
  const labels = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry(), entry({ ...acme, stateChange: false, benign: "same request repeated" })] }), ONE_REFUND, {});
  assert.equal("assumedKeyHosts" in labels, false);
});

test("analyzeCell reports a duplicate with a stable id as dupClass stable", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry(), entry()] }), ONE_REFUND, {});
  assert.equal(v.kind, "dup");
  assert.equal(v.dupClass, "stable");
  assert.equal(v.stateChanges, 2);
  assert.equal(v.expected, 1);
  assert.deepEqual(v.evidence, [{ endpoint: REFUNDS, count: 2, expected: 1, diffFields: [] }]);
});

test("analyzeCell reports a duplicate with a fresh id as dupClass fresh", () => {
  const run = crashRun({ cellId: "post-effect-fast-fresh", idMode: "fresh", ledger: [entry(), entry()] });
  const v = analyzeCell(cellOf("post-effect-fast-fresh"), run, ONE_REFUND, {});
  assert.equal(v.kind, "dup");
  assert.equal(v.dupClass, "fresh");
});

test("analyzeCell reports a duplicate after an interrupted call as dupClass retry", () => {
  const run = crashRun({ cellId: "post-effect-slow", crashPoint: "post-effect-slow", idMode: "fresh", calls: [call({ outcome: "abandoned" }), call({ callId: "call_2" })], ledger: [entry(), entry()] });
  const v = analyzeCell(cellOf("post-effect-slow"), run, ONE_REFUND, {});
  assert.equal(v.kind, "dup");
  assert.equal(v.recovery, "interrupted");
  assert.equal(v.dupClass, "retry");
});

test("analyzeCell treats an endpoint absent from the baseline as expected zero", () => {
  const other = entry({ endpoint: "POST slack.com/api/chat.postMessage", url: "https://slack.com/api/chat.postMessage" });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry(), other] }), ONE_REFUND, {});
  assert.equal(v.kind, "dup");
  assert.deepEqual(v.evidence.map((e) => [e.endpoint, e.count, e.expected]), [[REFUNDS, 1, 1], ["POST slack.com/api/chat.postMessage", 1, 0]]);
});

test("analyzeCell reports a lost effect when the model got a success and no state changed", () => {
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [catalogEntry()] }), ONE_REFUND, {});
  assert.equal(v.kind, "lost-effect");
  assert.equal(v.stateChanges, 0);
  assert.deepEqual(v.evidence, [{ endpoint: REFUNDS, count: 0, expected: 1, diffFields: [] }]);
});

test("analyzeCell reports a phantom failure when the effect happened once and the model got an error", () => {
  const run = crashRun({ calls: [call({ outcome: "failed", error: { message: "Blob already exists" } })], ledger: [entry()] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, {});
  assert.equal(v.kind, "phantom-failure");
  assert.equal(v.error, "Blob already exists");
});

test("analyzeCell is clean when the model got an explicit uncertain error or an abandoned call", () => {
  const uncertain = crashRun({ calls: [call({ outcome: "failed", error: "OUTCOME_UNKNOWN" })], ledger: [] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), uncertain, ONE_REFUND, {}).kind, "clean");
  const abandoned = crashRun({ calls: [call({ outcome: "abandoned" })], ledger: [] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), abandoned, ONE_REFUND, {}).kind, "clean");
});

test("analyzeCell lets a duplicate win over a lost effect or a phantom failure", () => {
  const failed = crashRun({ calls: [call({ outcome: "failed", error: "boom" })], ledger: [entry(), entry()] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), failed, ONE_REFUND, {}).kind, "dup");
});

test("analyzeCell drops entries matched by effects.ignore (glob on the url)", () => {
  const noisy = entry({ url: "https://api.stripe.com/v1/refunds/audit", endpoint: "POST api.stripe.com/v1/refunds/audit" });
  const run = crashRun({ ledger: [entry(), noisy, noisy] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, {}).kind, "dup");
  const ignored = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, { effects: { ignore: ["https://api.stripe.com/v1/refunds/*"] } });
  assert.equal(ignored.kind, "clean");
  assert.equal(ignored.stateChanges, 1);
});

test("effects.ignore globs are anchored and escape regex characters", () => {
  const run = crashRun({ ledger: [entry(), entry()] });
  const unmatched = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, { effects: { ignore: ["api.stripe.com/v1/refunds", "https://api.stripe.com/v1/refund", "https://api-stripe.com/*"] } });
  assert.equal(unmatched.kind, "dup");
  const matched = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, { effects: { ignore: [REFUNDS_URL] } });
  assert.equal(matched.stateChanges, 0);
});

test("analyzeCell lists the body fields that differ, minus volatile fields and callId", () => {
  const first = entry({ body: { callId: "c1", turnId: "t1", reason: "duplicate", amount: 500, requestId: "r1" } });
  const last = entry({ body: { callId: "c2", turnId: "t1", reason: "requested_by_customer", amount: 500, requestId: "r2" } });
  const v = analyzeCell(cellOf("post-effect-fast-fresh"), crashRun({ cellId: "post-effect-fast-fresh", idMode: "fresh", ledger: [first, last] }), { expected: { [REFUNDS]: 1 }, volatileFields: ["requestId"] }, {});
  assert.deepEqual(v.evidence[0]?.diffFields, ["reason"]);
});

test("analyzeCell compares first and last entry of an endpoint, treating missing keys as differences", () => {
  const first = entry({ body: { amount: 500, note: { a: 1, b: 2 } } });
  const middle = entry({ body: { amount: 1 } });
  const last = entry({ body: { note: { b: 2, a: 1 }, extra: true, amount: 500 } });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [first, middle, last] }), ONE_REFUND, {});
  assert.deepEqual(v.evidence[0]?.diffFields, ["extra"]);
});

test("analyzeCell gives no diff fields for a single entry or non-object bodies", () => {
  assert.deepEqual(analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry({ body: { a: 1 } })] }), ONE_REFUND, {}).evidence[0]?.diffFields, []);
  assert.deepEqual(analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [entry({ body: "a=1" }), entry({ body: "a=2" })] }), ONE_REFUND, {}).evidence[0]?.diffFields, []);
});

// --- baselineFacts --------------------------------------------------------------------------------------------

const naive = (partial: Parameters<typeof summary>[0] = {}) => summary({ tool: "naive", ledger: [catalogEntry(), entry({ body: { callId: "c1", reason: "x" } })], ...partial });

test("baselineFacts returns expected counts, volatile fields and approval for two matching baselines", () => {
  const b1 = naive({ approvals: 1, ledger: [catalogEntry(), entry({ body: { callId: "c1", reason: "x", amount: 5 } })] });
  const b2 = naive({ cellId: "baseline-2", ledger: [catalogEntry(), entry({ body: { callId: "c2", reason: "x", amount: 5, extra: 1 } })] });
  const facts = baselineFacts("naive", b1, b2, {});
  assert.deepEqual(facts, { ok: true, expected: { [REFUNDS]: 1 }, volatileFields: ["callId", "extra"], approval: true });
});

test("baselineFacts reports approval false when the first baseline needed none", () => {
  const facts = baselineFacts("naive", naive(), naive({ cellId: "baseline-2", approvals: 1 }), {});
  assert.ok(facts.ok);
  assert.equal(facts.approval, false);
});

test("baselineFacts counts only mutating state changes, never ledger position or length", () => {
  const ledger = [catalogEntry(), entry(), entry({ stateChange: false, benign: "repeat" }), catalogEntry()];
  const facts = baselineFacts("naive", naive({ ledger }), naive({ cellId: "baseline-2", ledger: [entry(), catalogEntry()] }), {});
  assert.ok(facts.ok);
  assert.deepEqual(facts.expected, { [REFUNDS]: 1 });
});

test("baselineFacts takes volatile fields from the first mutating entry of each baseline", () => {
  const b1 = naive({ ledger: [catalogEntry(), entry({ body: { a: 1, b: 1 } }), entry({ stateChange: false, benign: "repeat", body: { a: 9, b: 9 } })] });
  const b2 = naive({ cellId: "baseline-2", ledger: [entry({ body: { a: 1, b: 2 } })] });
  const facts = baselineFacts("naive", b1, b2, {});
  assert.ok(facts.ok);
  assert.deepEqual(facts.volatileFields, ["b"]);
});

test("baselineFacts is baseline-failed when the call failed with a validation error, naming the config key", () => {
  const failing = summary({ tool: "naive", calls: [call({ outcome: "failed", error: { message: "Invalid input: amount is required" } })], ledger: [] });
  const facts = baselineFacts("naive", failing, naive({ cellId: "baseline-2" }), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.equal(facts.detail, "Invalid input: amount is required — set scenarios.naive.input in crashtest.config.json");
  assert.match(facts.detail, /scenarios\.naive\.input/);
});

test("baselineFacts is baseline-failed for a string error and for the second baseline", () => {
  const failing = summary({ tool: "naive", cellId: "baseline-2", calls: [call({ outcome: "failed", error: "bad amount" })] });
  const facts = baselineFacts("naive", naive(), failing, {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.equal(facts.detail, "bad amount — set scenarios.naive.input in crashtest.config.json");
});

test("baselineFacts is baseline-failed when a run did not complete, lacks the preload or never called the tool", () => {
  for (const bad of [
    naive({ turnOutcome: "timeout" }),
    naive({ preloadReady: false }),
    naive({ calls: [] }),
    naive({ calls: [call({ tool: "other" })] }),
    naive({ calls: [call({ outcome: "abandoned" })] }),
    naive({ calls: [call({ outcome: "completed" }), call({ callId: "call_2", outcome: "failed" })] }),
  ]) {
    const facts = baselineFacts("naive", bad, naive({ cellId: "baseline-2" }), {});
    assert.ok(!facts.ok);
    assert.equal(facts.reason, "baseline-failed");
    assert.match(facts.detail, / — set scenarios\.naive\.input in crashtest\.config\.json$/);
    assert.ok(facts.detail.length > " — set scenarios.naive.input in crashtest.config.json".length, "the detail says what went wrong");
  }
});

test("baselineFacts judges the last call to the tool", () => {
  const recovered = naive({ calls: [call({ outcome: "failed", error: "first try failed" }), call({ callId: "call_2" })] });
  const facts = baselineFacts("naive", recovered, naive({ cellId: "baseline-2" }), {});
  assert.ok(facts.ok);
});

test("baselineFacts is baseline-unstable when the two baselines differ, showing both", () => {
  const b2 = naive({ cellId: "baseline-2", ledger: [entry(), entry()] });
  const facts = baselineFacts("naive", naive(), b2, {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-unstable");
  assert.match(facts.detail, /baseline 1: POST api\.stripe\.com\/v1\/refunds x1/);
  assert.match(facts.detail, /baseline 2: POST api\.stripe\.com\/v1\/refunds x2/);
});

test("baselineFacts is baseline-unstable when one baseline has no state change", () => {
  const facts = baselineFacts("naive", naive(), naive({ cellId: "baseline-2", ledger: [catalogEntry()] }), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-unstable");
  assert.match(facts.detail, /baseline 2: no state change/);
});

test("baselineFacts is no-effect when neither baseline changed any state", () => {
  const quiet = (cellId: "baseline-1" | "baseline-2") => naive({ cellId, ledger: [catalogEntry(), entry({ method: "GET", endpoint: "GET api.stripe.com/v1/refunds", mutating: false, stateChange: false })] });
  const facts = baselineFacts("naive", quiet("baseline-1"), quiet("baseline-2"), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "no-effect");
});

test("baselineFacts applies effects.ignore before counting", () => {
  const noisy = entry({ url: "https://telemetry.example.com/v1/events", endpoint: "POST telemetry.example.com/v1/events" });
  const b1 = naive({ ledger: [entry(), noisy] });
  const b2 = naive({ cellId: "baseline-2", ledger: [entry(), noisy, noisy] });
  assert.equal(baselineFacts("naive", b1, b2, {}).ok, false);
  const facts = baselineFacts("naive", b1, b2, { effects: { ignore: ["https://telemetry.example.com/*"] } });
  assert.ok(facts.ok);
  assert.deepEqual(facts.expected, { [REFUNDS]: 1 });

  const onlyNoise = baselineFacts("naive", naive({ ledger: [noisy] }), naive({ cellId: "baseline-2", ledger: [noisy] }), { effects: { ignore: ["https://telemetry.example.com/*"] } });
  assert.ok(!onlyNoise.ok);
  assert.equal(onlyNoise.reason, "no-effect");
});
