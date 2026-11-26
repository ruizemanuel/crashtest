// Runs crashtest the way the CLI does: a fresh lab copy of the app, the overlay, discovery, then the lanes and the
// report files. Every entry point removes the lab when it is done unless asked to keep it; the evidence of each run
// stays in `<outDir>/runs/`.
import { statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CrashtestConfig } from "./config.ts";
import { discover, type Discovery } from "./discover.ts";
import { EngineError } from "./errors.ts";
import { createLab, removeLab, type Lab } from "./lab.ts";
import { runLane } from "./lane.ts";
import { CORE_CELLS } from "./matrix.ts";
import { applyOverlay } from "./overlay.ts";
import { installDependencies } from "./package-manager.ts";
import { renderBadge } from "./report/badge.ts";
import { buildReport } from "./report/build.ts";
import { renderMarkdown } from "./report/markdown.ts";
import type { CellId, EveFacts, LaneResult, Report, ToolInfo } from "./types.ts";

/** Rough wall time of one cell, for the plan's estimate. */
export const SECONDS_PER_CELL = 15;

export interface AuditPlan {
  eve: EveFacts;
  tools: { name: string; cells: CellId[] }[];
  skipped: { name: string; reason: string }[];
  /** `SECONDS_PER_CELL` for every planned cell, one run each: confirmation runs and retries are not counted. */
  estimatedSeconds: number;
}

/** Where an audit writes its report, inside the output directory. */
export interface ReportFiles {
  json: string;
  markdown: string;
  badge: string;
}

export interface AuditOptions {
  appDir: string;
  /** Only these tools (default: every discovered tool). */
  tools?: string[];
  config: CrashtestConfig;
  /** Install the app's dependencies from its lockfile first. */
  install?: boolean;
  keepLab?: boolean;
  onProgress?: (line: string) => void;
}

export interface AuditLaneOptions {
  appDir: string;
  tool: string;
  config: CrashtestConfig;
  keepLab?: boolean;
  onProgress?: (line: string) => void;
}

export function reportFiles(outDir: string): ReportFiles {
  return { json: join(outDir, "report.json"), markdown: join(outDir, "report.md"), badge: join(outDir, "badge.svg") };
}

/** What a run of the discovered tools would do: the core cells for each, and the estimate. */
export function planOf(discovery: Discovery): AuditPlan {
  const cells = CORE_CELLS.map((cell) => cell.id);
  const tools = discovery.tools.map((tool) => ({ name: tool.name, cells: [...cells] }));
  return { eve: discovery.eve, tools, skipped: discovery.skipped, estimatedSeconds: SECONDS_PER_CELL * cells.length * tools.length };
}

/**
 * The tools to run and the skips to report for `names` (every tool when undefined). A name that discovery knows
 * neither as a tool nor as a skip is an error that lists the names it does know; skips of tools outside `names`
 * are dropped, so the report covers only the tools asked for.
 */
export function selectTools(discovery: Discovery, names?: readonly string[]): { tools: ToolInfo[]; skipped: Discovery["skipped"] } {
  if (names === undefined) return { tools: discovery.tools, skipped: discovery.skipped };
  const known = [...discovery.tools, ...discovery.skipped].map((tool) => tool.name).sort();
  const unknown = [...new Set(names)].filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? "unknown tool" : "unknown tools";
    const found = known.length === 0 ? "none" : known.join(", ");
    throw new EngineError(`${label} ${unknown.map((name) => `"${name}"`).join(", ")}; tools found: ${found}`);
  }
  const wanted = new Set(names);
  return { tools: discovery.tools.filter((tool) => wanted.has(tool.name)), skipped: discovery.skipped.filter((skip) => wanted.has(skip.name)) };
}

/** Discovers the app's tools in a lab that is removed again, without starting `eve dev`. */
export async function planAudit(o: { appDir: string; config: CrashtestConfig; onProgress?: (line: string) => void }): Promise<AuditPlan> {
  return withLab(appDirOf(o.appDir), o.config, false, o.onProgress, async (_lab, discovery) => planOf(discovery));
}

/** Runs the lane of one tool. No report files are written; the evidence stays in `<outDir>/runs/<tool>/`. */
export async function auditLane(o: AuditLaneOptions): Promise<{ lane: LaneResult; eve: EveFacts }> {
  return withLab(appDirOf(o.appDir), o.config, o.keepLab ?? false, o.onProgress, async (lab, discovery) => {
    const [tool] = selectTools(discovery, [o.tool]).tools;
    if (tool === undefined) {
      const reason = discovery.skipped.find((skip) => skip.name === o.tool)?.reason ?? "not discovered";
      throw new EngineError(`tool "${o.tool}" cannot run: ${reason}`);
    }
    const lane = await runLane({ lab, tool, config: o.config, onProgress: o.onProgress });
    return { lane, eve: discovery.eve };
  });
}

/** The full audit: every selected tool's lane, then `report.json`, `report.md` and `badge.svg` in the output directory. */
export async function audit(o: AuditOptions): Promise<{ report: Report; lanes: LaneResult[]; files: ReportFiles }> {
  const appDir = appDirOf(o.appDir);
  if (o.install) installDependencies(appDir);
  return withLab(appDir, o.config, o.keepLab ?? false, o.onProgress, async (lab, discovery) => {
    const { tools, skipped } = selectTools(discovery, o.tools);
    for (const skip of skipped) o.onProgress?.(`[crashtest] ${skip.name} skipped: ${skip.reason}`);
    const lanes: LaneResult[] = [];
    for (const tool of tools) lanes.push(await runLane({ lab, tool, config: o.config, onProgress: o.onProgress }));
    const report = buildReport({ appDir: lab.appDir, eve: discovery.eve, lanes, skipped, outDir: lab.outDir });
    const files = reportFiles(lab.outDir);
    writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(files.markdown, renderMarkdown(report));
    writeFileSync(files.badge, renderBadge(report));
    return { report, lanes, files };
  });
}

/** The absolute app directory; one that does not exist is an error before anything is created on disk. */
function appDirOf(dir: string): string {
  const app = resolve(dir);
  let isDirectory: boolean;
  try {
    isDirectory = statSync(app).isDirectory();
  } catch {
    throw new EngineError(`the app directory ${app} does not exist`);
  }
  if (!isDirectory) throw new EngineError(`the app ${app} is not a directory`);
  return app;
}

/**
 * Runs `work` on a fresh lab of the app that is overlaid and discovered, then removes the lab unless `keep`.
 * A lab that cannot be removed is reported, not thrown: the work is done, and the next run wipes the lab anyway.
 */
async function withLab<T>(
  appDir: string,
  config: CrashtestConfig,
  keep: boolean,
  onProgress: ((line: string) => void) | undefined,
  work: (lab: Lab, discovery: Discovery) => Promise<T>,
): Promise<T> {
  const lab = createLab(appDir);
  try {
    applyOverlay(lab.labDir);
    return await work(lab, await discover(lab, config));
  } finally {
    if (keep) {
      onProgress?.(`[crashtest] lab kept at ${lab.labDir}`);
    } else {
      try {
        removeLab(lab);
      } catch (err) {
        onProgress?.(`[crashtest] could not remove the lab ${lab.labDir}: ${(err as Error).message}`);
      }
    }
  }
}
