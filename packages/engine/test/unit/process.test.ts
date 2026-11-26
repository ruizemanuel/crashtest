import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineError } from "../../src/errors.ts";
import { killAllTracked, killTree, preloadImportFlag, resolveEveBin, spawnTracked, withPreload } from "../../src/driver/process.ts";

const ENGINE_DIR = join(import.meta.dirname, "..", "..");

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("preloadImportFlag encodes spaces", () => {
  const p = process.platform === "win32" ? "C:\\Users\\John Doe\\x\\index.js" : "/home/John Doe/x/index.js";
  assert.match(preloadImportFlag(p), /^--import=file:\/\/\/.*John%20Doe\/x\/index\.js$/);
});

test("withPreload keeps existing options", () => {
  assert.equal(withPreload("--max-old-space-size=512", "--import=x"), "--max-old-space-size=512 --import=x");
});

test("withPreload without existing options is just the flag", () => {
  assert.equal(withPreload(undefined, "--import=x"), "--import=x");
  assert.equal(withPreload("", "--import=x"), "--import=x");
});

test("resolveEveBin finds the pinned eve and its executable", () => {
  const { bin, version } = resolveEveBin(ENGINE_DIR);
  assert.equal(version, "1.5.0");
  assert.ok(existsSync(bin), `bin exists: ${bin}`);
  assert.match(bin.replaceAll("\\", "/"), /\/eve\/bin\/eve\.js$/);
});

test("resolveEveBin explains how to fix a missing install", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-no-eve-"));
  try {
    assert.throws(
      () => resolveEveBin(dir),
      (err: unknown) =>
        err instanceof EngineError && err.message === `eve is not installed for ${dir}: install the app's dependencies first`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("killAllTracked kills a long-running child", async () => {
  const child = spawnTracked(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    assert.equal(typeof child.pid, "number");
    killAllTracked();
    assert.ok(await exited(child, 5000), "child exited within 5 s");
  } finally {
    killTree(child);
  }
});

test("killAllTracked and killTree ignore children that already exited", async () => {
  const child = spawnTracked(process.execPath, ["-e", ""], { stdio: "ignore" });
  try {
    assert.ok(await exited(child, 10_000), "child exited on its own");
    assert.doesNotThrow(() => killAllTracked());
    assert.doesNotThrow(() => killTree(child));
  } finally {
    killTree(child);
  }
});
