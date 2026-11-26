// Turns the lane results of a run into the versioned report that the Markdown and the badge are rendered from.
// Everything here is pure except the lookup of the app name and git state, which tests can override.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { engineVersion } from "../paths.ts";
import { rateAgent, rateTool } from "../rate.ts";
import type { EveFacts, LaneResult, Report } from "../types.ts";

export interface GitFacts {
  commit: string | null;
  dirty: boolean;
}

export interface BuildReportOptions {
  appDir: string;
  eve: EveFacts;
  lanes: LaneResult[];
  /** What discovery skipped: only tools eve did not list are reported; tools excluded by config are left out. */
  skipped: { name: string; reason: string }[];
  /** The moment the report is made; defaults to now. */
  now?: Date;
  /** The git state of the app; read from `appDir` when not given. */
  git?: GitFacts;
}

const GIT_TIMEOUT_MS = 10_000;
const NOT_LISTED = "not listed by eve info";

/** The `package.json#name` of the app, else the name of its directory. */
function targetName(appDir: string): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
    const name = typeof pkg === "object" && pkg !== null ? (pkg as { name?: unknown }).name : undefined;
    if (typeof name === "string" && name.trim() !== "") return name;
  } catch {
    // no package.json, or not valid JSON: fall back to the directory name
  }
  return basename(resolve(appDir));
}

/** The stdout of `git -C <appDir> <args>`, or null when git is missing or the command fails. */
function git(appDir: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", appDir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return result.error !== undefined || result.status !== 0 ? null : result.stdout;
}

/** The short commit of `HEAD` and whether the working tree has uncommitted changes; both empty outside a repository. */
function readGit(appDir: string): GitFacts {
  const commit = git(appDir, ["rev-parse", "--short=7", "HEAD"])?.trim();
  if (commit === undefined || commit === "") return { commit: null, dirty: false };
  const status = git(appDir, ["status", "--porcelain"]);
  return { commit, dirty: status !== null && status.trim() !== "" };
}

export function buildReport(o: BuildReportOptions): Report {
  const notListed = o.skipped
    .filter((tool) => tool.reason === NOT_LISTED)
    .map((tool) => rateTool({ tool: tool.name, approval: false, cells: [], identity: [], na: { reason: "not-discovered", detail: tool.reason } }));
  const tools = [...o.lanes.map((lane) => lane.rating), ...notListed];
  const { commit, dirty } = o.git ?? readGit(o.appDir);

  return {
    schemaVersion: 1,
    engine: { name: "eve-crashtest", version: engineVersion },
    createdAt: (o.now ?? new Date()).toISOString(),
    target: { name: targetName(o.appDir), commit, dirty },
    eve: o.eve,
    lab: { platform: process.platform, node: process.versions.node, cells: o.lanes.reduce((sum, lane) => sum + lane.runs, 0) },
    agent: rateAgent(tools),
    tools,
  };
}
