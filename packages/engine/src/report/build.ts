// Turns the lane results of a run into the versioned report that the Markdown and the badge are rendered from.
// Everything here is pure except the lookup of the app name and git state, which tests can override.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { SKIP_NOT_LISTED } from "../discover.ts";
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
  /** Where the engine writes its output (reports, runs, lab); its files never count as changes to the app. Defaults to `<appDir>/.crashtest`. */
  outDir?: string;
  /** The git state of the app; read from `appDir` when not given. */
  git?: GitFacts;
}

const GIT_TIMEOUT_MS = 10_000;

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

/** `outDir` as a posix path relative to `appDir`, or null when it is the app itself or lies outside it. */
function outDirInApp(appDir: string, outDir: string): string | null {
  const rel = relative(resolve(appDir), resolve(outDir)).split("\\").join("/");
  return rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel;
}

/**
 * The short commit of `HEAD` and whether the app has uncommitted changes; both empty outside a repository.
 * Only changes inside the app count, and the output directory is left out: the engine has just written into it, and
 * that is not a change to the code that was tested. A `git status` that fails or times out reads as dirty: a tree
 * nobody could check is not a clean one.
 */
export function readGit(appDir: string, outDir: string): GitFacts {
  const commit = git(appDir, ["rev-parse", "--short=7", "HEAD"])?.trim();
  if (commit === undefined || commit === "") return { commit: null, dirty: false };
  const out = outDirInApp(appDir, outDir);
  const scope = out === null ? ["."] : [".", `:(exclude,literal)${out}`];
  const status = git(appDir, ["--no-optional-locks", "status", "--porcelain", "--", ...scope]);
  return { commit, dirty: status === null || status.trim() !== "" };
}

export function buildReport(o: BuildReportOptions): Report {
  const notListed = o.skipped
    .filter((tool) => tool.reason === SKIP_NOT_LISTED)
    .map((tool) => rateTool({ tool: tool.name, approval: false, cells: [], identity: [], na: { reason: "not-discovered", detail: tool.reason } }));
  const tools = [...o.lanes.map((lane) => lane.rating), ...notListed];
  const { commit, dirty } = o.git ?? readGit(o.appDir, o.outDir ?? join(o.appDir, ".crashtest"));

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
