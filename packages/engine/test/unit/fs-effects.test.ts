import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const CHILD = fileURLToPath(new URL("./fs-effects-child.mjs", import.meta.url));

test("a write made from inside record is never observed, so record cannot recurse", (t) => {
  const lab = mkdtempSync(join(tmpdir(), "ct-fs-effects-"));
  const runDir = mkdtempSync(join(tmpdir(), "ct-fs-effects-run-"));
  t.after(() => {
    rmSync(lab, { recursive: true, force: true });
    rmSync(runDir, { recursive: true, force: true });
  });
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [CHILD, lab, runDir], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout) as unknown, [
    ["WRITE", "a.txt", "a"],
    ["APPEND", "b.log", "b\n"],
    ["WRITE", "c.txt", "c"],
    ["APPEND", "d.log", "d\n"],
    ["WRITE", "e.txt", "e"],
    ["APPEND", "f.log", "f\n"],
  ]);
});
