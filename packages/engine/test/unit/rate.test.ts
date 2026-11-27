import assert from "node:assert/strict";
import { test } from "node:test";
import { rateAgent, rateTool } from "../../src/rate.ts";
import type { CellVerdict, ToolRating } from "../../src/types.ts";
import { REFUNDS, verdict } from "./builders.ts";

const IDENTITY = ["orderId", "amount"];
const LOOKUP = " The provider supports a lookup, so the tool can also check whether the effect already happened before acting.";
const UNKNOWN_HINT = "No duplicates, but after recovery the model sees a misleading result. Return an explicit uncertain-outcome error (`OUTCOME_UNKNOWN`) instead of a generic failure.";

const CLEAN: CellVerdict[] = [verdict({ cellId: "post-effect-fast-fresh" }), verdict({ cellId: "post-settle" })];

/** A duplicate verdict with `count` effects on `endpoint`. */
function dup(dupClass: "stable" | "fresh" | "retry", cellId: CellVerdict["cellId"], count = 2, endpoint = REFUNDS): CellVerdict {
  return verdict({ cellId, kind: "dup", dupClass, stateChanges: count, evidence: [{ endpoint, count, expected: 1, diffFields: [] }] });
}

const rate = (cells: CellVerdict[], extra: Partial<Parameters<typeof rateTool>[0]> = {}): ToolRating =>
  rateTool({ tool: "naive", approval: false, cells, identity: IDENTITY, ...extra });

// --- the rating table -----------------------------------------------------------------------------------------

test("a stable-id duplicate without approval is 1 star", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable"), ...CLEAN]);
  assert.equal(rating.stars, 1);
  assert.equal(rating.summary, "Ran twice after a crash replayed the step with the same call id (2 effects, expected 1).");
  assert.equal(rating.recommendation, `Send an idempotency key built from business identity fields (\`orderId\`, \`amount\`), not \`ctx.callId\`.${LOOKUP}`);
  assert.equal(rating.approval, false);
  assert.deepEqual(rating.identity, IDENTITY);
  assert.equal(rating.benignRepeats, false);
});

test("a stable-id duplicate on a tool that needs approval is 2 stars", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable"), ...CLEAN], { approval: true });
  assert.equal(rating.stars, 2);
  assert.equal(rating.approval, true);
});

test("a duplicate only with a fresh id is 3 stars", () => {
  const rating = rate([verdict(), dup("fresh", "post-effect-fast-fresh"), verdict({ cellId: "post-settle" })]);
  assert.equal(rating.stars, 3);
  assert.equal(rating.summary, "Ran twice when the replayed call got a new id and rewritten text (2 effects, expected 1).");
  assert.equal(rating.recommendation, `The protection is tied to \`ctx.callId\`, which changes when the model re-issues the call after a crash. Key it on identity fields (\`orderId\`, \`amount\`) instead.${LOOKUP}`);
});

test("a duplicate only through a retry is 3 stars", () => {
  const rating = rate([verdict(), dup("retry", "post-effect-slow", 3), verdict({ cellId: "post-settle" })]);
  assert.equal(rating.stars, 3);
  assert.equal(rating.summary, "Ran twice when the model retried a call eve reported as interrupted (3 effects, expected 1).");
  assert.match(rating.recommendation, /^The protection is tied to `ctx\.callId`/);
});

test("a phantom failure is 4 stars and quotes the error the model got", () => {
  const phantom = verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error: "Blob already exists" });
  const rating = rate([verdict(), phantom, verdict({ cellId: "post-settle" })]);
  assert.equal(rating.stars, 4);
  assert.equal(rating.summary, "The effect happened once, but after recovery the model got an error: Blob already exists");
  assert.equal(rating.recommendation, UNKNOWN_HINT);
});

test("a long error is quoted up to 200 characters and then cut with an ellipsis", () => {
  const summaryFor = (error: string) => {
    const phantom = verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error });
    return rate([verdict(), phantom]).summary;
  };
  const prefix = "The effect happened once, but after recovery the model got an error: ";
  assert.equal(summaryFor("x".repeat(200)), `${prefix}${"x".repeat(200)}`, "exactly 200 characters is quoted whole");
  assert.equal(summaryFor("x".repeat(201)), `${prefix}${"x".repeat(200)}…`);
  assert.equal(summaryFor("y".repeat(5000)), `${prefix}${"y".repeat(200)}…`);
  const emoji = summaryFor("😀".repeat(250)).slice(prefix.length);
  assert.equal(emoji, `${"😀".repeat(200)}…`, "the cut never splits a character");
});

test("a lost effect reported as success is 4 stars", () => {
  const lost = verdict({ cellId: "post-effect-slow", kind: "lost-effect", stateChanges: 0 });
  const rating = rate([verdict(), lost]);
  assert.equal(rating.stars, 4);
  assert.equal(rating.summary, "The model got a success, but no effect reached the provider.");
  assert.equal(rating.recommendation, UNKNOWN_HINT);
});

test("a tool whose recovery leaves an explicit uncertain outcome is 5 stars", () => {
  const uncertain = verdict({ cellId: "post-effect-slow", outcome: "uncertain", stateChanges: 0 });
  const rating = rate([verdict(), uncertain]);
  assert.equal(rating.stars, 5);
  assert.equal(rating.summary, "One state change in every cell, and the model always got a truthful result.");
  assert.equal(rating.recommendation, "No change needed.");
  assert.equal(rating.benignRepeats, false);
});

test("repeated requests that changed no state keep 5 stars and are called out", () => {
  const rating = rate([verdict({ benignRepeats: 1 }), verdict({ cellId: "post-settle" })]);
  assert.equal(rating.stars, 5);
  assert.equal(rating.benignRepeats, true);
  assert.equal(rating.summary, "One state change in every cell; repeated requests did not change provider state.");
  assert.equal(rating.recommendation, "Idempotent by nature: no change needed.");
});

// --- invalid cells --------------------------------------------------------------------------------------------

const invalidCell = (cellId: CellVerdict["cellId"], invalidReason = "crash-not-triggered"): CellVerdict => verdict({ cellId, kind: "invalid", invalidReason });
const STANDS = (cells: string) => ` The rating stands without the cells that could not be evaluated: ${cells}.`;

test("one invalid cell makes a tool without a duplicate not evaluable (cells-invalid)", () => {
  const rating = rate([verdict(), verdict({ cellId: "post-effect-fast-fresh" }), verdict({ cellId: "post-effect-slow" }), invalidCell("post-settle")]);
  assert.equal(rating.stars, null);
  assert.equal(rating.na?.reason, "cells-invalid");
  assert.equal(rating.na?.detail, "post-settle (crash-not-triggered)");
  assert.equal(rating.summary, "Some crash cells could not be evaluated: post-settle (crash-not-triggered)");
  assert.equal(rating.recommendation, "");
});

test("an invalid cell can hide a duplicate, so a misleading result alone is not rated either", () => {
  const phantom = verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error: "x" });
  const rating = rate([verdict(), phantom, invalidCell("post-effect-slow")]);
  assert.equal(rating.stars, null);
  assert.equal(rating.na?.reason, "cells-invalid");
});

test("a confirmed stable-id duplicate keeps its 1 star, or 2 with approval, whatever cells are invalid", () => {
  const cells = [dup("stable", "post-effect-fast-stable"), invalidCell("post-effect-fast-fresh", "turn-timeout"), verdict({ cellId: "post-effect-slow" }), invalidCell("post-settle")];
  const rating = rate(cells);
  assert.equal(rating.stars, 1);
  assert.equal(rating.na, undefined);
  assert.equal(
    rating.summary,
    `Ran twice after a crash replayed the step with the same call id (2 effects, expected 1).${STANDS("post-effect-fast-fresh (turn-timeout), post-settle (crash-not-triggered)")}`,
  );
  assert.match(rating.recommendation, /^Send an idempotency key built from business identity fields/);
  assert.deepEqual(rating.cells, cells, "the invalid cells stay in the evidence");
  assert.equal(rate(cells, { approval: true }).stars, 2);
});

test("a fresh or retry duplicate gives 3 stars with an invalid cell when both stable-id cells could be evaluated", () => {
  const cells = [verdict(), dup("fresh", "post-effect-fast-fresh"), invalidCell("post-effect-slow", "unexpected-death"), verdict({ cellId: "post-settle" })];
  const rating = rate(cells);
  assert.equal(rating.stars, 3);
  assert.equal(rating.na, undefined);
  assert.equal(rating.summary, `Ran twice when the replayed call got a new id and rewritten text (2 effects, expected 1).${STANDS("post-effect-slow (unexpected-death)")}`);

  const retry = rate([verdict(), invalidCell("post-effect-fast-fresh"), dup("retry", "post-effect-slow"), verdict({ cellId: "post-settle" })]);
  assert.equal(retry.stars, 3);
});

test("a fresh or retry duplicate is not rated while a stable-id cell is invalid or missing: it could hide a worse one", () => {
  for (const stableCell of ["post-effect-fast-stable", "post-settle"] as const) {
    const others = (["post-effect-fast-stable", "post-settle"] as const).filter((id) => id !== stableCell).map((cellId) => verdict({ cellId }));
    const rating = rate([invalidCell(stableCell), dup("retry", "post-effect-slow"), ...others]);
    assert.equal(rating.stars, null, stableCell);
    assert.equal(rating.na?.reason, "cells-invalid", stableCell);
    assert.equal(rating.na?.detail, `${stableCell} (crash-not-triggered)`, stableCell);
  }
  const missing = rate([dup("fresh", "post-effect-fast-fresh"), invalidCell("post-effect-slow"), verdict({ cellId: "post-settle" })]);
  assert.equal(missing.stars, null, "post-effect-fast-stable did not run");
});

test("without invalid cells the summary names none", () => {
  assert.doesNotMatch(rate([dup("stable", "post-effect-fast-stable"), ...CLEAN]).summary, /could not be evaluated/);
});

test("several invalid cells are all named in the detail", () => {
  const cells = [
    verdict({ cellId: "post-effect-fast-stable", kind: "invalid", invalidReason: "turn-timeout" }),
    verdict({ cellId: "post-effect-fast-fresh" }),
    verdict({ cellId: "post-settle", kind: "invalid", invalidReason: "no-call" }),
  ];
  assert.equal(rate(cells).na?.detail, "post-effect-fast-stable (turn-timeout), post-settle (no-call)");
});

test("a tool with no cells is not evaluable", () => {
  const rating = rate([]);
  assert.equal(rating.stars, null);
  assert.equal(rating.na?.reason, "cells-invalid");
});

test("an na input passes through with its fixed summary and an empty recommendation", () => {
  const cases: [Parameters<typeof rateTool>[0]["na"], string][] = [
    [{ reason: "no-effect", detail: "" }, "No external effect observed in the baseline."],
    [{ reason: "baseline-failed", detail: "bad input — set scenarios.naive.input in crashtest.config.json" }, "The baseline run failed: bad input — set scenarios.naive.input in crashtest.config.json"],
    [{ reason: "baseline-unstable", detail: "baseline 1: a x1; baseline 2: none" }, "The two baseline runs produced different effects: baseline 1: a x1; baseline 2: none"],
    [{ reason: "cells-invalid", detail: "post-settle (no-call)" }, "Some crash cells could not be evaluated: post-settle (no-call)"],
    [{ reason: "not-discovered", detail: "" }, "eve did not list this tool."],
  ];
  for (const [na, summary] of cases) {
    const rating = rate([dup("stable", "post-effect-fast-stable")], { na });
    assert.equal(rating.stars, null);
    assert.deepEqual(rating.na, na);
    assert.equal(rating.summary, summary);
    assert.equal(rating.recommendation, "");
    assert.equal(rating.benignRepeats, false);
  }
});

test("a waiver keeps the computed stars and sets waived", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable"), ...CLEAN], { waiver: "Refunds are idempotent downstream" });
  assert.equal(rating.stars, 1);
  assert.equal(rating.waived, "Refunds are idempotent downstream");
  assert.equal("waived" in rate(CLEAN), false);
});

test("a stable duplicate beats a fresh one, and 2 stars keeps the same copy as 1", () => {
  const rating = rate([dup("fresh", "post-effect-fast-fresh", 4), dup("stable", "post-effect-fast-stable", 2)]);
  assert.equal(rating.stars, 1);
  assert.match(rating.summary, /same call id \(2 effects, expected 1\)/);
});

test("n and e come from the worst evidence", () => {
  const worse = verdict({
    cellId: "post-effect-fast-stable",
    kind: "dup",
    dupClass: "stable",
    stateChanges: 5,
    evidence: [
      { endpoint: "POST slack.com/api/chat.postMessage", count: 1, expected: 1, diffFields: [] },
      { endpoint: REFUNDS, count: 4, expected: 1, diffFields: [] },
    ],
  });
  const rating = rate([dup("stable", "post-effect-fast-fresh", 2), worse]);
  assert.match(rating.summary, /\(4 effects, expected 1\)/);
});

// --- recommendation by host -----------------------------------------------------------------------------------

test("a stable duplicate on a host without idempotency keys gets the operation-ledger recommendation", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable", 2, "POST api.example.com/v1/charges")]);
  assert.equal(
    rating.recommendation,
    "Guard `execute` with an operation ledger keyed on session, turn, tool and identity fields (`orderId`, `amount`); report an explicit uncertain outcome when a previous attempt started but did not finish.",
  );
});

test("a stable duplicate on a Slack-like host gets the ledger recommendation plus the lookup hint", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable", 2, "POST slack.com/api/chat.postMessage")]);
  assert.match(rating.recommendation, /^Guard `execute` with an operation ledger/);
  assert.ok(rating.recommendation.endsWith(LOOKUP));
});

test("the lookup hint is only for 3 stars or fewer on a host that supports lookups", () => {
  assert.ok(rate([dup("fresh", "post-effect-fast-fresh", 2, "POST api.github.com/repos/o/r/issues/1/comments")]).recommendation.endsWith(LOOKUP));
  assert.ok(!rate([dup("fresh", "post-effect-fast-fresh", 2, "POST api.example.com/v1/x")]).recommendation.includes("lookup"));
  const phantom = verdict({ kind: "phantom-failure", outcome: "error", error: "x" });
  assert.ok(!rate([phantom]).recommendation.includes("lookup"));
});

test("an idempotent host with no identity fields drops the field list from the copy", () => {
  const rating = rate([dup("stable", "post-effect-fast-stable")], { identity: [] });
  assert.ok(rating.recommendation.startsWith("Send an idempotency key built from business identity fields, not `ctx.callId`."));
  const fresh = rate([dup("fresh", "post-effect-fast-fresh")], { identity: [] });
  assert.ok(fresh.recommendation.includes("Key it on identity fields instead."));
});

test("user-facing copy never claims a tool is verified or safe", () => {
  const phantom = verdict({ kind: "phantom-failure", outcome: "error", error: "x" });
  const lost = verdict({ kind: "lost-effect" });
  const all = [
    rate([dup("stable", "post-effect-fast-stable")]),
    rate([dup("fresh", "post-effect-fast-fresh")]),
    rate([dup("retry", "post-effect-slow")]),
    rate([phantom]),
    rate([lost]),
    rate(CLEAN),
    rate([verdict({ benignRepeats: 2 })]),
    rate([], {}),
  ];
  for (const rating of all) assert.doesNotMatch(`${rating.summary} ${rating.recommendation}`, /verified|safe/i);
});

// --- rateAgent ------------------------------------------------------------------------------------------------

function toolRating(tool: string, stars: ToolRating["stars"], extra: Partial<ToolRating> = {}): ToolRating {
  return { tool, stars, approval: false, benignRepeats: false, identity: [], summary: "", recommendation: "", cells: [], ...extra };
}

test("rateAgent is the minimum over tools with stars, with coverage", () => {
  const agent = rateAgent([toolRating("a", 5), toolRating("b", 3), toolRating("c", 4), toolRating("d", null), toolRating("e", null)]);
  assert.deepEqual(agent, { stars: 3, evaluated: 3, total: 5 });
});

test("rateAgent leaves waived tools out of the minimum and the coverage", () => {
  const agent = rateAgent([toolRating("a", 5), toolRating("b", 1, { waived: "downstream dedupe" })]);
  assert.deepEqual(agent, { stars: 5, evaluated: 1, total: 2 });
});

test("rateAgent has no stars when no tool was evaluated", () => {
  assert.deepEqual(rateAgent([toolRating("a", null), toolRating("b", 2, { waived: "x" })]), { stars: null, evaluated: 0, total: 2 });
  assert.deepEqual(rateAgent([]), { stars: null, evaluated: 0, total: 0 });
});
