import assert from "node:assert/strict";
import { test } from "node:test";
import { planOf, SECONDS_PER_CELL, selectTools } from "../../src/audit.ts";
import { SKIP_EXCLUDED, SKIP_NOT_LISTED, type Discovery } from "../../src/discover.ts";
import { EngineError } from "../../src/errors.ts";
import { CORE_CELLS } from "../../src/matrix.ts";

const DISCOVERY: Discovery = {
  tools: [
    { name: "naive", file: "agent/tools/naive.ts", inputSchema: null },
    { name: "readonly", file: "agent/tools/readonly.ts", inputSchema: null },
    { name: "refund", file: "agent/tools/refund.ts", inputSchema: null },
  ],
  skipped: [
    { name: "ghost", reason: SKIP_NOT_LISTED },
    { name: "off", reason: SKIP_EXCLUDED },
  ],
  eve: { version: "1.5.0", capabilities: { replayNever: false } },
};

const names = (items: { name: string }[]): string[] => items.map((item) => item.name);

test("without a tool list every discovered tool runs and every skip is kept", () => {
  const selected = selectTools(DISCOVERY);
  assert.deepEqual(names(selected.tools), ["naive", "readonly", "refund"]);
  assert.deepEqual(selected.skipped, DISCOVERY.skipped);
});

test("a tool list keeps only the listed tools and the skips among them", () => {
  const selected = selectTools(DISCOVERY, ["refund", "ghost", "naive"]);
  assert.deepEqual(names(selected.tools), ["naive", "refund"]);
  assert.deepEqual(selected.skipped, [{ name: "ghost", reason: SKIP_NOT_LISTED }]);
});

test("a listed tool that discovery does not know is an error that lists the tools it found", () => {
  assert.throws(
    () => selectTools(DISCOVERY, ["naive", "nope", "typo"]),
    (err: unknown) =>
      err instanceof EngineError &&
      /unknown tools "nope", "typo"/.test(err.message) &&
      /ghost, naive, off, readonly, refund/.test(err.message),
  );
  const none: Discovery = { ...DISCOVERY, tools: [], skipped: [] };
  assert.throws(() => selectTools(none, ["naive"]), /unknown tool "naive"; tools found: none/);
});

test("the plan gives every tool the core cells and estimates one run per cell", () => {
  const plan = planOf(DISCOVERY);
  assert.deepEqual(plan.eve, DISCOVERY.eve);
  assert.deepEqual(names(plan.tools), ["naive", "readonly", "refund"]);
  for (const tool of plan.tools) assert.deepEqual(tool.cells, CORE_CELLS.map((cell) => cell.id));
  assert.deepEqual(plan.skipped, DISCOVERY.skipped);
  assert.equal(SECONDS_PER_CELL, 15);
  assert.equal(plan.estimatedSeconds, 15 * 6 * 3);
  assert.equal(planOf({ ...DISCOVERY, tools: [] }).estimatedSeconds, 0);
});
