import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hashTree, prepareLab, tool, zooDir } from "./helpers.ts";

test("smoke: discover the zoo", { timeout: 900_000 }, async () => {
  const before = hashTree(zooDir, ["node_modules", ".crashtest", ".eve"]);
  const { lab, discovery } = await prepareLab(zooDir);
  assert.deepEqual(discovery.tools.map((t) => t.name), [
    "approval_naive",
    "benign_labels",
    "blob_default",
    "blob_overwrite",
    "blob_reworded",
    "callid_guard",
    "check_before_act",
    "fs_effect",
    "naive",
    "opkey_guard",
    "phantom_failure",
    "post_reads",
    "put_timestamped",
    "readonly",
    "refuses_as_value",
    "session_auth",
    "strict_input",
    "upstream_key",
  ]);
  assert.equal(discovery.eve.version, "1.5.0"); assert.equal(discovery.eve.capabilities.replayNever, false);
  assert.deepEqual(Object.keys((tool(discovery, "naive").inputSchema as any).properties), ["to", "orderId", "text"]);
  assert.ok(existsSync(join(lab.labDir, "agent", "agent.ctorig.spec.ts")));
  // eve info ran with the preload, so whatever it fetched was answered by the fake provider.
  assert.ok(existsSync(join(lab.outDir, "runs", "_discover", "preload.ready")), "eve info loaded the preload");
  assert.equal(hashTree(zooDir, ["node_modules", ".crashtest", ".eve"]), before);
});
