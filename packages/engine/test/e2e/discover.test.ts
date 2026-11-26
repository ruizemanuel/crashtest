import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hashTree, prepareLab, tool, zooDir } from "./helpers.ts";

test("smoke: discover the zoo", { timeout: 900_000 }, async () => {
  const before = hashTree(zooDir, ["node_modules", ".crashtest", ".eve"]);
  const { lab, discovery } = await prepareLab(zooDir);
  assert.deepEqual(discovery.tools.map((t) => t.name), ["approval_naive", "naive", "readonly"]);
  assert.equal(discovery.eve.version, "1.5.0"); assert.equal(discovery.eve.capabilities.replayNever, false);
  assert.deepEqual(Object.keys((tool(discovery, "naive").inputSchema as any).properties), ["to", "orderId", "text"]);
  assert.ok(existsSync(join(lab.labDir, "agent", "agent.ctorig.spec.ts")));
  // eve info ran with the preload, so whatever it fetched was answered by the fake provider.
  assert.ok(existsSync(join(lab.outDir, "runs", "_discover", "preload.ready")), "eve info loaded the preload");
  assert.equal(hashTree(zooDir, ["node_modules", ".crashtest", ".eve"]), before);
});
