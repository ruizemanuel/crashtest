import assert from "node:assert/strict";
import { test } from "node:test";
import { MASKED_REPEAT, analyzeCell, baselineFacts, maskRepeats, refusalOf, volatileFieldsOf } from "../../src/detect.ts";
import { CORE_CELLS, cellLabel, crashCells } from "../../src/matrix.ts";
import { KEY_REPLAY } from "../../src/preload/fake-provider.ts";
import type { Cell, CellId, LedgerEntry } from "../../src/types.ts";
import { REFUNDS, REFUNDS_URL, call, catalogEntry, entry, summary } from "./builders.ts";

function cellOf(id: CellId): Cell {
  const cell = CORE_CELLS.find((candidate) => candidate.id === id);
  assert.ok(cell, `no core cell ${id}`);
  return cell;
}

const ONE_REFUND = { expected: { [REFUNDS]: 1 }, volatileFields: [] as string[], volatileByEndpoint: {} };

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
  const base = { expected: { [REFUNDS]: 1, [acme.endpoint]: 1 }, volatileFields: [] as string[], volatileByEndpoint: {} };
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
  const v = analyzeCell(cellOf("post-effect-fast-fresh"), crashRun({ cellId: "post-effect-fast-fresh", idMode: "fresh", ledger: [first, last] }), { expected: { [REFUNDS]: 1 }, volatileFields: ["requestId"], volatileByEndpoint: { [REFUNDS]: ["requestId"] } }, {});
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
  assert.deepEqual(facts, {
    ok: true,
    expected: { [REFUNDS]: 1 },
    volatileFields: ["callId", "extra"],
    volatileByEndpoint: { [REFUNDS]: ["callId", "extra"] },
    approval: true,
  });
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

test("baselineFacts takes volatile fields from each endpoint's entries paired by order, and an unpaired entry adds none", () => {
  const b1 = naive({ ledger: [catalogEntry(), entry({ body: { a: 1, b: 1 } }), entry({ stateChange: false, benign: "repeat", body: { a: 9, b: 9 } })] });
  const b2 = naive({ cellId: "baseline-2", ledger: [entry({ body: { a: 1, b: 2 } })] });
  const facts = baselineFacts("naive", b1, b2, {});
  assert.ok(facts.ok);
  assert.deepEqual(facts.volatileFields, ["b"]);
  assert.deepEqual(facts.volatileByEndpoint, { [REFUNDS]: ["b"] });
});

test("baselineFacts is baseline-failed when the call failed with a validation error, naming the config key", () => {
  const failing = summary({ tool: "naive", calls: [call({ outcome: "failed", error: { message: "Invalid input: amount is required" } })], ledger: [] });
  const facts = baselineFacts("naive", failing, naive({ cellId: "baseline-2" }), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.equal(facts.detail, "Invalid input: amount is required — set scenarios.naive.input in crashtest.config.json");
  assert.match(facts.detail, /scenarios\.naive\.input/);
});

const GENERAL_HINT = " — see the run directory; crashtest.config.json can set scenarios.naive.input, auth, env and fixtures";

test("baselineFacts is baseline-failed for a string error and for the second baseline", () => {
  const failing = summary({ tool: "naive", cellId: "baseline-2", calls: [call({ outcome: "failed", error: "bad amount" })] });
  const facts = baselineFacts("naive", naive(), failing, {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.equal(facts.detail, `bad amount${GENERAL_HINT}`);
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
    assert.ok(facts.detail.endsWith(GENERAL_HINT), facts.detail);
    assert.ok(facts.detail.length > GENERAL_HINT.length, "the detail says what went wrong");
  }
});

test("baseline hints follow the failure", () => {
  const detailFor = (error: string): string => {
    const failing = summary({ tool: "naive", calls: [call({ outcome: "failed", error: { message: error } })], ledger: [] });
    const facts = baselineFacts("naive", failing, naive({ cellId: "baseline-2" }), {});
    assert.ok(!facts.ok);
    assert.equal(facts.reason, "baseline-failed");
    return facts.detail;
  };
  const authHint = " — set auth or scenarios.naive.auth in crashtest.config.json to give the lab session the identity this tool checks";
  for (const error of ["Authorization denied: not in a Slack context", "No GitHub repository on the session. This tool only runs on GitHub-triggered turns."]) {
    assert.equal(detailFor(error), `${error}${authHint}`);
  }
  const invalid = "Invalid input: expected string, received undefined";
  assert.equal(detailFor(invalid), `${invalid} — set scenarios.naive.input in crashtest.config.json`);
  assert.equal(detailFor("fetch failed"), `fetch failed${GENERAL_HINT}`);
});

test("a baseline problem the engine words itself always gets the general hint", () => {
  const startup = naive({ calls: [], turnOutcome: "startup-failed", error: "session create failed: 500 invalid context" });
  const facts = baselineFacts("naive", startup, naive({ cellId: "baseline-2" }), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.equal(facts.detail, `the turn ended as startup-failed: session create failed: 500 invalid context${GENERAL_HINT}`);
});

// --- refusals and rejected inputs ---------------------------------------------------------------------------

/** A completed run of tool `t` whose call returned `output`; it makes no state change unless `ledger` says otherwise. */
function returned(cellId: CellId, output: unknown, ledger: LedgerEntry[] = [catalogEntry()]) {
  return summary({ tool: "t", cellId, calls: [call({ tool: "t", output })], ledger });
}

test("a refusal returned as a value is a failed baseline with the auth hint", () => {
  const output = { success: false, error: "Authorization denied: not in a Slack context" };
  const facts = baselineFacts("t", returned("baseline-1", output), returned("baseline-2", output), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.match(facts.detail, /^the call returned a refusal: Authorization denied/);
  assert.match(facts.detail, /— set auth or scenarios\.t\.auth in crashtest\.config\.json to give the lab session the identity this tool checks$/);
});

test("outputs that report success are not refusals", () => {
  for (const output of [{ success: true, error: null }, { ok: true, error: "x" }, { error: "" }, "done", null, { ok: true }]) {
    assert.equal(refusalOf(output), null, JSON.stringify(output));
  }
});

test("refusalOf takes the first text that says why, else the output cut to 200 characters", () => {
  assert.equal(refusalOf({ success: false, error: { message: "No such skill" }, message: "later" }), "No such skill");
  assert.equal(refusalOf({ ok: false, error: "", message: "", reason: "channel_not_found" }), "channel_not_found");
  assert.equal(refusalOf({ ok: false, error: "not_in_channel" }), "not_in_channel");
  const bare = { success: false, detail: "x".repeat(300) };
  assert.equal(refusalOf(bare), JSON.stringify(bare).slice(0, 200));
  // Without success or ok, an error is a refusal only when it has words.
  assert.equal(refusalOf({ error: "No global skill named demo" }), "No global skill named demo");
  assert.equal(refusalOf({ error: { message: "Rate limited" } }), "Rate limited");
  assert.equal(refusalOf({ error: { code: 7 } }), null);
  assert.equal(refusalOf(["error"]), null);
});

test("a refusal with an effect in the baselines is not re-read", () => {
  const output = { success: false, error: "Authorization denied: not in a Slack context" };
  const facts = baselineFacts("t", returned("baseline-1", output, [entry()]), returned("baseline-2", output, [entry()]), {});
  assert.equal(facts.ok, true);
});

test("a refusal after the effect in a cell is a phantom failure", () => {
  const run = crashRun({ calls: [call({ output: { success: false, error: "Already exists" } })], ledger: [entry()] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, {});
  assert.equal(v.kind, "phantom-failure");
  assert.equal(v.outcome, "error");
  assert.equal(v.error, "Already exists");
});

test("a refusal that says the outcome is unknown is an uncertain outcome", () => {
  const run = crashRun({ calls: [call({ output: { ok: false, error: "OUTCOME_UNKNOWN: the upload may have happened" } })], ledger: [entry()] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), run, ONE_REFUND, {});
  assert.equal(v.kind, "clean");
  assert.equal(v.outcome, "uncertain");
  assert.equal("error" in v, false);
});

test("a rejected input is a failed baseline with the input hint, even when the input mentions a session", () => {
  const rejected = summary({ tool: "t", calls: [], firstToolError: 'Invalid input for tool t: Type validation failed: Value: {"session":"x"}' });
  const facts = baselineFacts("t", rejected, returned("baseline-2", { ok: true }, [entry()]), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.match(facts.detail, /^the call was rejected before t ran: Invalid input/);
  assert.ok(facts.detail.endsWith("— set scenarios.t.input in crashtest.config.json"), facts.detail);
});

test("a rejected input is used only when the stream has no call to the tool", () => {
  const failing = summary({ tool: "t", calls: [call({ tool: "t", outcome: "failed", error: "boom" })], firstToolError: "Invalid input for tool t: Type validation failed" });
  const facts = baselineFacts("t", failing, returned("baseline-2", { ok: true }, [entry()]), {});
  assert.ok(!facts.ok);
  assert.equal(facts.reason, "baseline-failed");
  assert.ok(facts.detail.startsWith("boom"), facts.detail);
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

// --- repeated writes ------------------------------------------------------------------------------------------

const PROFILE_URL = "https://api.acme-store.test/v1/profiles/42";
const PROFILE_PUT = "PUT api.acme-store.test/v1/profiles/:id";
const PROFILE_POST = "POST api.acme-store.test/v1/profiles/:id";
const PROFILE_DELETE = "DELETE api.acme-store.test/v1/profiles/:id";

/**
 * A state-changing write to the profile of customer 42, with `object` set as the fake provider sets it: the
 * generic slot for a PUT, PATCH or DELETE, nothing for a POST.
 */
function profileWrite(method: "PUT" | "POST" | "DELETE", body: unknown, partial: Partial<LedgerEntry> = {}): LedgerEntry {
  const object = method === "POST" ? {} : { object: `${method} api.acme-store.test/v1/profiles/42` };
  return entry({ method, url: PROFILE_URL, endpoint: `${method} api.acme-store.test/v1/profiles/:id`, ...object, body, ...partial });
}

/** Baseline facts of one write to the profile endpoint whose `volatile` fields vary on their own. */
function profileBase(volatileByEndpoint: Record<string, string[]>, endpoint = PROFILE_PUT) {
  return { expected: { [endpoint]: 1 }, volatileFields: [...new Set(Object.values(volatileByEndpoint).flat())].sort(), volatileByEndpoint };
}

test("volatileFieldsOf pairs entries by endpoint and order", () => {
  const first = [
    profileWrite("PUT", { v: 1, t: "1" }),
    profileWrite("POST", { w: 1, u: "a" }),
    profileWrite("PUT", { v: 2, t: "2" }),
    profileWrite("DELETE", { reason: "closed" }),
  ];
  const second = [
    profileWrite("POST", { w: 1, u: "b" }),
    profileWrite("DELETE", { reason: "closed" }),
    profileWrite("PUT", { v: 1, t: "3" }),
    profileWrite("PUT", { v: 2, t: "4" }),
  ];
  // `v` differs between the two PUTs of one run, not between the runs; the DELETE endpoint varies in nothing.
  assert.deepEqual(volatileFieldsOf(first, second), { [PROFILE_PUT]: ["t"], [PROFILE_POST]: ["u"] });
});

test("a repeat that differs only in varying fields is benign", () => {
  const volatile = { [PROFILE_PUT]: ["updatedAt"] };
  const writes = [profileWrite("PUT", { name: "Ada", updatedAt: "1" }), profileWrite("PUT", { name: "Ada", updatedAt: "2" })];
  const before = structuredClone(writes);

  const masked = maskRepeats(writes, volatile);
  assert.deepEqual(masked.entries, [writes[0], { ...writes[1], stateChange: false, benign: MASKED_REPEAT }]);
  assert.deepEqual(masked.maskedFields, ["updatedAt"]);
  assert.deepEqual(writes, before, "the input is not mutated");

  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: [catalogEntry(), ...writes] }), profileBase(volatile), {});
  assert.equal(v.kind, "clean");
  assert.equal(v.stateChanges, 1);
  assert.equal(v.benignRepeats, 1);
  assert.deepEqual(v.maskedFields, ["updatedAt"]);
});

test("a repeat that changes a field the baselines agree on is still a state change", () => {
  const volatile = { [PROFILE_PUT]: ["updatedAt"] };
  const writes = [profileWrite("PUT", { count: 1, updatedAt: "1" }), profileWrite("PUT", { count: 2, updatedAt: "2" })];
  assert.deepEqual(maskRepeats(writes, volatile), { entries: writes, maskedFields: [] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: writes }), profileBase(volatile), {});
  assert.equal(v.kind, "dup");
  assert.equal(v.stateChanges, 2);
  assert.equal("maskedFields" in v, false);
});

test("a write to another object is not a repeat", () => {
  const volatile = { [PROFILE_PUT]: ["updatedAt"] };
  const other = { url: "https://api.acme-store.test/v1/profiles/43", object: "PUT api.acme-store.test/v1/profiles/43" };
  const writes = [profileWrite("PUT", { name: "Ada" }), profileWrite("PUT", { name: "Ada" }, other)];
  assert.deepEqual(maskRepeats(writes, volatile), { entries: writes, maskedFields: [] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: writes }), profileBase(volatile), {});
  assert.equal(v.stateChanges, 2);
  assert.equal(v.kind, "dup");
});

test("a fixture-answered PUT repeat stays a state change", () => {
  // A fixture answers without naming the object, so nothing says that the second write overwrote the first.
  const volatile = { [PROFILE_PUT]: ["updatedAt"] };
  const fixturePut = (body: unknown) => entry({ method: "PUT", url: PROFILE_URL, endpoint: PROFILE_PUT, body });
  const cases = [
    [fixturePut({ name: "Ada", updatedAt: "1" }), fixturePut({ name: "Ada", updatedAt: "2" })],
    [fixturePut({ name: "Ada" }), fixturePut({ name: "Ada" })],
  ];
  for (const writes of cases) {
    assert.deepEqual(maskRepeats(writes, volatile), { entries: writes, maskedFields: [] });
    const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: writes }), profileBase(volatile), {});
    assert.equal(v.kind, "dup");
    assert.equal(v.stateChanges, 2);
  }
});

test("a field that varies on another endpoint does not mask this one", () => {
  const volatile = { [PROFILE_POST]: ["updatedAt"] };
  const writes = [profileWrite("PUT", { name: "Ada", updatedAt: "1" }), profileWrite("PUT", { name: "Ada", updatedAt: "2" })];
  assert.deepEqual(maskRepeats(writes, volatile), { entries: writes, maskedFields: [] });
  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: writes }), profileBase(volatile), {});
  assert.equal(v.stateChanges, 2);
  assert.equal(v.kind, "dup");
});

test("a tool that rewrites its own object in one turn is measured the same in baselines and cells", () => {
  const rewrites = (...stamps: string[]) => stamps.map((updatedAt) => profileWrite("PUT", { v: 1, updatedAt }));
  const b1 = naive({ ledger: [catalogEntry(), ...rewrites("1", "2")] });
  const b2 = naive({ cellId: "baseline-2", ledger: [catalogEntry(), ...rewrites("3", "4")] });
  const facts = baselineFacts("naive", b1, b2, {});
  assert.ok(facts.ok);
  assert.deepEqual(facts.expected, { [PROFILE_PUT]: 1 });
  assert.deepEqual(facts.volatileByEndpoint, { [PROFILE_PUT]: ["updatedAt"] });
  assert.deepEqual(facts.volatileFields, ["updatedAt"]);

  const v = analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: rewrites("5", "6", "7", "8") }), facts, {});
  assert.equal(v.kind, "clean");
  assert.equal(v.stateChanges, 1);
  assert.equal(v.benignRepeats, 3);
});

test("a DELETE repeat is masked, a POST repeat never is", () => {
  const deletes = [profileWrite("DELETE", { reason: "closed", requestedAt: "1" }), profileWrite("DELETE", { reason: "closed", requestedAt: "2" })];
  const maskedDelete = maskRepeats(deletes, { [PROFILE_DELETE]: ["requestedAt"] });
  assert.deepEqual(maskedDelete.entries, [deletes[0], { ...deletes[1], stateChange: false, benign: MASKED_REPEAT }]);
  assert.deepEqual(maskedDelete.maskedFields, ["requestedAt"]);

  // Even with the object named, a POST adds to it rather than overwriting it.
  const named = { object: "POST api.acme-store.test/v1/profiles/42" };
  const posts = [profileWrite("POST", { name: "Ada", sentAt: "1" }, named), profileWrite("POST", { name: "Ada", sentAt: "2" }, named)];
  const volatile = { [PROFILE_POST]: ["sentAt"] };
  assert.deepEqual(maskRepeats(posts, volatile), { entries: posts, maskedFields: [] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: posts }), profileBase(volatile, PROFILE_POST), {}).kind, "dup");
});

test("bodies that are not objects compare whole", () => {
  const volatile = { [PROFILE_PUT]: ["updatedAt"] };
  const differing = [profileWrite("PUT", "name=Ada;updatedAt=1"), profileWrite("PUT", "name=Ada;updatedAt=2")];
  assert.deepEqual(maskRepeats(differing, volatile), { entries: differing, maskedFields: [] });
  assert.equal(analyzeCell(cellOf("post-effect-fast-stable"), crashRun({ ledger: differing }), profileBase(volatile), {}).kind, "dup");

  const same = [profileWrite("PUT", "%PDF-1.7 profile"), profileWrite("PUT", "%PDF-1.7 profile")];
  assert.deepEqual(maskRepeats(same, volatile), { entries: [same[0], { ...same[1], stateChange: false, benign: MASKED_REPEAT }], maskedFields: [] });
});

test("entries that are already benign or not state changes are left as they are", () => {
  const profileFile = { kind: "fs" as const, method: "WRITE", url: "data/profile.json", endpoint: "WRITE data/profile.json", status: 0 };
  const volatile = { [PROFILE_PUT]: ["updatedAt"], [profileFile.endpoint]: ["updatedAt"] };
  const ledger = [
    profileWrite("PUT", { name: "Ada", updatedAt: "1" }, { idempotencyKey: "k1" }),
    profileWrite("PUT", { name: "Ada", updatedAt: "1" }, { idempotencyKey: "k1", stateChange: false, benign: KEY_REPLAY }),
    profileWrite("PUT", { name: "Ada", updatedAt: "2" }, { stateChange: false, status: 412 }),
    entry({ ...profileFile, body: { name: "Ada", updatedAt: "1" } }),
    entry({ ...profileFile, body: { name: "Ada", updatedAt: "2" } }),
  ];
  assert.deepEqual(maskRepeats(ledger, volatile), { entries: ledger, maskedFields: [] });
});
