import assert from "node:assert/strict";
import { test } from "node:test";
import { runLane } from "../../src/lane.ts";
import { crashCells } from "../../src/matrix.ts";
import { prepareLab, tool, zooDir } from "./helpers.ts";

// A real lane: two baselines, four crash cells and any retries or confirmations, each a full `eve dev` life.
const E2E = { timeout: 900_000 };

test("smoke: naive lane rates 1 star", E2E, async (t) => {
  const { lab, discovery } = await prepareLab(zooDir);
  const result = await runLane({ lab, tool: tool(discovery, "naive"), config: {}, onProgress: (line) => t.diagnostic(line) });

  for (const cell of result.rating.cells) {
    t.diagnostic(`${cell.cellId}: ${cell.kind}${cell.dupClass ? ` (${cell.dupClass})` : ""}, ${cell.stateChanges}/${cell.expected} effects, attempts ${cell.attempts}${cell.seen ? `, seen ${cell.seen}` : ""}`);
  }
  t.diagnostic(`naive: ${result.rating.stars} stars in ${result.runs} runs, ${(result.wallMs / 1000).toFixed(1)} s`);

  const detail = JSON.stringify(result.rating);
  assert.equal(result.tool, "naive");
  assert.equal(result.rating.stars, 1, detail);
  assert.deepEqual(result.rating.cells.map((cell) => cell.cellId), crashCells().map((cell) => cell.id), detail);
  assert.ok(result.rating.cells.every((cell) => cell.kind !== "invalid"), detail);
  assert.ok(result.rating.cells.some((cell) => cell.kind === "dup" && cell.dupClass === "stable"), detail);
  assert.ok(result.runs >= 6, `a lane makes at least six runs, made ${result.runs}`);
  assert.ok(result.wallMs > 0);
});
