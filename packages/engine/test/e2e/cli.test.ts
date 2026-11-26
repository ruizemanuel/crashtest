import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { killPort, listenerPids } from "../../src/driver/ports.ts";
import { CORE_CELLS } from "../../src/matrix.ts";
import { renderBadge } from "../../src/report/badge.ts";
import { commitLabel } from "../../src/report/format.ts";
import type { Report } from "../../src/types.ts";
import { zooDir } from "./helpers.ts";

// Every test here drives the `crashtest` bin end to end on the zoo; `run` makes real lanes, each cell a full
// `eve dev` life. The CLI runs as a child process: capturing this process's stdout instead would also swallow the
// test runner's own reporting, which shares that stream.
const E2E = { timeout: 900_000 };
const outDir = join(zooDir, ".crashtest");
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "cli.ts");
const BANNED = /\b(verified|safe)\b/i;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `crashtest <argv>` to its exit; its stderr (the progress) is replayed as diagnostics. */
function cli(t: TestContext, argv: string[], cwd?: string): Promise<CliRun> {
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

function removeReports(): void {
  for (const file of ["report.json", "report.md", "badge.svg"]) rmSync(join(outDir, file), { force: true });
}

function readReport(): Report {
  return JSON.parse(readFileSync(join(outDir, "report.json"), "utf8")) as Report;
}

/** Every per-tool run directory under `runs/` with its modification time; `_discover` is discovery's own. */
function cellRunDirs(): Record<string, number> {
  const runs = join(outDir, "runs");
  const found: Record<string, number> = {};
  if (!existsSync(runs)) return found;
  for (const tool of readdirSync(runs)) {
    if (tool === "_discover") continue;
    found[tool] = statSync(join(runs, tool)).mtimeMs;
    for (const cell of readdirSync(join(runs, tool))) found[`${tool}/${cell}`] = statSync(join(runs, tool, cell)).mtimeMs;
  }
  return found;
}

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() >= until) assert.fail(what);
    await sleep(200);
  }
}

test("smoke: run writes report, markdown and badge", E2E, async (t) => {
  removeReports();
  const run = await cli(t, ["run", "--app", zooDir, "--tools", "naive,readonly"]);
  assert.equal(run.code, 0, run.stderr);

  const report = readReport();
  assert.deepEqual(report.agent, { stars: 1, evaluated: 1, total: 2 }, JSON.stringify(report.agent));
  assert.deepEqual(report.tools.map((tool) => tool.tool).sort(), ["naive", "readonly"]);
  assert.equal(report.eve.version, "1.5.0");
  const markdown = readFileSync(join(outDir, "report.md"), "utf8");
  assert.match(markdown, /^## Crashtest report\n/);
  assert.match(readFileSync(join(outDir, "badge.svg"), "utf8"), /^<svg [^>]*>[\s\S]*★☆☆☆☆ eve 1\.5\.0/);
  assert.ok(!existsSync(join(outDir, "lab")), "the lab is removed after the run");

  assert.equal(
    run.stdout,
    `Report: ${join(outDir, "report.md")}\nAgent rating: ★☆☆☆☆ (1/5) · 1 of 2 tools evaluated · In lab: ${report.lab.cells} cells · eve 1.5.0 · commit ${commitLabel(report.target)}\n`,
  );
  assert.match(run.stderr, /^\[crashtest\] naive baseline-1 a1 port=\d+$/m, "progress goes to stderr");
  assert.doesNotMatch(run.stdout + run.stderr + markdown, BANNED);
});

test("--min-stars fails the run below the bar", E2E, async (t) => {
  removeReports();
  const run = await cli(t, ["run", "--app", zooDir, "--tools", "naive,readonly", "--min-stars", "2"]);
  assert.equal(run.code, 1, run.stderr);
  assert.match(run.stderr, /^crashtest: the agent rating 1\/5 is below --min-stars 2$/m);
  assert.equal(readReport().agent.stars, 1, "the report is written even when the bar fails");
  assert.ok(!existsSync(join(outDir, "lab")), "the lab is removed after the run");
});

test("plan --json lists tools and cells without running eve dev", E2E, async (t) => {
  const before = cellRunDirs();
  const run = await cli(t, ["plan", "--app", zooDir, "--json"]);
  assert.equal(run.code, 0, run.stderr);

  const plan = JSON.parse(run.stdout) as {
    eve: { version: string; capabilities: { replayNever: boolean } };
    tools: { name: string; cells: string[] }[];
    skipped: { name: string; reason: string }[];
    estimatedSeconds: number;
  };
  assert.deepEqual(plan.eve, { version: "1.5.0", capabilities: { replayNever: false } });
  const names = plan.tools.map((tool) => tool.name);
  for (const name of ["approval_naive", "naive", "readonly"]) assert.ok(names.includes(name), `${name} is planned; planned: ${names.join(", ")}`);
  for (const tool of plan.tools) assert.deepEqual(tool.cells, CORE_CELLS.map((cell) => cell.id), tool.name);
  assert.ok(Array.isArray(plan.skipped));
  assert.equal(plan.estimatedSeconds, 15 * CORE_CELLS.length * plan.tools.length);

  assert.deepEqual(cellRunDirs(), before, "plan ran no cell");
  assert.ok(existsSync(join(outDir, "runs", "_discover", "preload.ready")), "discovery ran with the preload");
  assert.ok(!existsSync(join(outDir, "lab")), "the lab is removed after the plan");
});

test("badge re-renders from report.json", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ct-badge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report: Report = {
    schemaVersion: 1,
    engine: { name: "eve-crashtest", version: "0.1.0" },
    createdAt: "2026-12-02T10:30:00.000Z",
    target: { name: "zoo", commit: "abc1234", dirty: false },
    eve: { version: "1.5.0", capabilities: { replayNever: false } },
    lab: { platform: "linux", node: "24.2.0", cells: 30 },
    agent: { stars: 4, evaluated: 1, total: 1 },
    tools: [],
  };
  const reportFile = join(dir, ".crashtest", "report.json");
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  // The badge lands next to the report by default.
  const nextToReport = await cli(t, ["badge", "--report", reportFile]);
  assert.equal(nextToReport.code, 0, nextToReport.stderr);
  const defaultOut = join(dir, ".crashtest", "badge.svg");
  assert.equal(nextToReport.stdout, `${defaultOut}\n`);
  assert.equal(readFileSync(defaultOut, "utf8"), renderBadge(report));
  assert.match(readFileSync(defaultOut, "utf8"), /★★★★☆ eve 1\.5\.0/);

  const custom = join(dir, "badges", "crashtest.svg");
  const toOut = await cli(t, ["badge", "--report", reportFile, "--out", custom]);
  assert.equal(toOut.code, 0, toOut.stderr);
  assert.equal(readFileSync(custom, "utf8"), renderBadge(report));

  // Without flags it reads and writes `.crashtest/` in the current directory.
  rmSync(defaultOut);
  const plain = await cli(t, ["badge"], dir);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(readFileSync(defaultOut, "utf8"), renderBadge(report));
});

test("SIGINT leaves no listener behind", { ...E2E, skip: process.platform === "win32" }, async (t) => {
  const child = spawn(process.execPath, [cliPath, "lane", "--tool", "naive", "--app", zooDir], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.resume();
  child.stderr.setEncoding("utf8");
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      const found = /^\[crashtest\] \S+ \S+ a\d+ port=(\d+)$/m.exec(stderr);
      if (found) resolve(Number(found[1]));
    });
    void exited.then(({ code, signal }) => reject(new Error(`the CLI exited (${code ?? signal}) before it printed a port:\n${stderr}`)));
  });
  t.diagnostic(`first cell on port ${port}`);

  try {
    // SIGINT must land while eve dev is up, or there would be nothing to leave behind.
    await waitFor(() => (listenerPids(port) ?? []).length > 0, 120_000, `eve dev never listened on port ${port}:\n${stderr}`);
    child.kill("SIGINT");
    const result = await Promise.race([exited, sleep(10_000).then(() => null)]);
    assert.ok(result !== null, `the CLI did not exit within 10 s of SIGINT:\n${stderr}`);
    assert.equal(result.code, 130, stderr);

    // The kills went out before the CLI exited; give the kernel a moment to close the dead server's socket.
    await waitFor(() => listenerPids(port)?.length === 0, 5000, `port ${port} still has listeners: ${JSON.stringify(listenerPids(port))}`);
    assert.deepEqual(listenerPids(port), []);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    killPort(port);
  }
});
