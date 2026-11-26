import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixTool, type FixOutcome } from "../../src/fix/fix.ts";
import { hashTree, zooDir } from "./helpers.ts";

// Two real lanes: the before lane of `naive` and the lane of the ledger-guard candidate, each cell a full `eve dev`
// life. upstream-key does not apply to the zoo's generic host, so it runs no lane.
const E2E = { timeout: 1_500_000 };
const outDir = join(zooDir, ".crashtest");
const SOURCE_SKIP = ["node_modules", ".crashtest", ".eve"];

test("fix: ledger-guard takes naive from 1 to 5 stars in the lab and leaves the zoo as it was", E2E, async (t) => {
  const source = hashTree(zooDir, SOURCE_SKIP);
  const t0 = Date.now();
  const outcome = await fixTool({ appDir: zooDir, tool: "naive", config: {}, onProgress: (line) => t.diagnostic(line) });
  const detail = JSON.stringify({ ...outcome, candidates: outcome.candidates.map(({ files: _files, ...rest }) => rest), chosen: outcome.chosen?.strategy });
  t.diagnostic(`fix of naive: ${outcome.before.stars} -> ${outcome.chosen?.after?.stars} stars, ${outcome.chosen?.runs} runs, ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  assert.equal(outcome.tool, "naive");
  assert.equal(outcome.before.stars, 1, detail);
  assert.deepEqual(outcome.identity, ["to", "orderId"]);
  assert.deepEqual(outcome.candidates.map((candidate) => candidate.strategy), ["upstream-key", "ledger-guard"]);
  const [upstream] = outcome.candidates;
  assert.equal(upstream?.applied, false, detail);
  assert.match(upstream?.reason ?? "", /idempotency-capable host/);
  assert.equal(upstream?.after, undefined, "a candidate that does not apply runs no lane");

  const { chosen, patchPath } = outcome;
  assert.ok(chosen, detail);
  assert.equal(chosen.strategy, "ledger-guard", detail);
  assert.equal(chosen.after?.stars, 5, detail);
  assert.equal(chosen.eveVersion, "1.5.0");
  assert.ok((chosen.runs ?? 0) >= 6, `a lane makes at least six runs, made ${chosen.runs}`);
  assert.deepEqual(chosen.files?.map((file) => file.path), ["agent/tools/naive.ts", "agent/lib/crashtest-idempotency.ts"]);

  assert.equal(patchPath, ".crashtest/fix/naive.patch");
  const patch = readFileSync(join(zooDir, ".crashtest", "fix", "naive.patch"), "utf8");
  t.diagnostic(patch.split("\n").slice(0, 40).join("\n"));
  assert.match(patch, /once\(/);
  assert.ok(patch.includes("--- a/agent/tools/naive.ts\n+++ b/agent/tools/naive.ts\n"), "the tool file is patched");
  assert.ok(patch.includes("--- /dev/null\n+++ b/agent/lib/crashtest-idempotency.ts\n"), "the helper is created");
  const recorded = JSON.parse(readFileSync(join(outDir, "fix", "naive.json"), "utf8")) as FixOutcome;
  assert.deepEqual(recorded, JSON.parse(JSON.stringify(outcome)), "naive.json records the outcome");

  assert.equal(hashTree(zooDir, SOURCE_SKIP), source, "the zoo's own files are unchanged");
  for (const lab of ["lab", "lab-fix-upstream-key", "lab-fix-ledger-guard"]) assert.ok(!existsSync(join(outDir, lab)), `${lab} is removed`);
});
