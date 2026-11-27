import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { discover, type Discovery } from "../../src/discover.ts";
import { createLab, type Lab } from "../../src/lab.ts";
import { applyOverlay } from "../../src/overlay.ts";
import type { ToolInfo } from "../../src/types.ts";

/** The engine's own eve test app: one tool per rating case. */
export const zooDir: string = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "zoo");

/** The `crashtest` bin, run from its TypeScript source. */
export const cliPath: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `crashtest <argv>` as a child process to its exit; its stderr (the progress) is replayed as diagnostics.
 * Capturing this process's stdout instead would also swallow the test runner's own reporting, which shares that stream.
 */
export function cli(t: TestContext, argv: string[], cwd?: string): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      for (const line of stderr.split(/\r?\n/).filter(Boolean)) t.diagnostic(line);
      if (code === null) reject(new Error(`crashtest ${argv.join(" ")} was killed by ${signal}:\n${stderr}`));
      else resolve({ code, stdout, stderr });
    });
  });
}

/** What every e2e test needs first: a fresh lab copy of the app, overlaid and discovered. */
export async function prepareLab(appDir: string, opts: { outDir?: string; labDir?: string } = {}): Promise<{ lab: Lab; discovery: Discovery }> {
  const lab = createLab(appDir, opts);
  applyOverlay(lab.labDir);
  return { lab, discovery: await discover(lab, {}) };
}

export function tool(discovery: Discovery, name: string): ToolInfo {
  const found = discovery.tools.find((t) => t.name === name);
  assert.ok(found, `tool "${name}" was not discovered; found: ${discovery.tools.map((t) => t.name).join(", ")}`);
  return found;
}

/** sha256 over the sorted relative paths and contents of every file under `dir` whose path has no segment in `skipSegments`. */
export function hashTree(dir: string, skipSegments: string[]): string {
  const skip = new Set(skipSegments);
  const hash = createHash("sha256");
  const walk = (rel: string): void => {
    const entries = readdirSync(join(dir, ...rel.split("/").filter(Boolean)), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else hash.update(`${child}\0`).update(readFileSync(join(dir, ...child.split("/")))).update("\0");
    }
  };
  walk("");
  return hash.digest("hex");
}
