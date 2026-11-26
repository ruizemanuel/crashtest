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

function closed(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

test(
  "killTree reaches the process group after the leader exited (POSIX)",
  { skip: process.platform === "win32" ? "process groups are POSIX only; Windows keeps the exited-child guard" : false },
  async () => {
    // A crash cell SIGKILLs the leader while a worker it started may survive in its process group.
    const leaderScript = [
      'const { spawn } = require("node:child_process");',
      'const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "process.stdout.write(String(worker.pid), () => process.exit(0));",
    ].join("\n");
    const leader = spawnTracked(process.execPath, ["-e", leaderScript], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    leader.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    assert.ok(await closed(leader, 10_000), "the leader exited on its own");
    const worker = Number(out.trim());
    assert.ok(Number.isInteger(worker) && worker > 0, `worker pid printed: ${JSON.stringify(out)}`);
    try {
      assert.ok(alive(worker), "the worker outlived its leader");
      killTree(leader);
      assert.ok(await goneWithin(worker, 5000), "killTree killed the worker left in the group");
    } finally {
      try {
        process.kill(worker, "SIGKILL");
      } catch {
        // already gone
      }
    }
  },
);

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
