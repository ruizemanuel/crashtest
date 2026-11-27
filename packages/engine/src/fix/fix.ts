// `crashtest fix`: for a tool that a crash can make run twice, each codemod is applied to its own lab copy of the
// app, the tool's lane runs again on that copy, and a candidate whose rating improves becomes the proposed patch.
// The source app is written only by `applyFix`. The outputs go to `<app>/.crashtest/fix/`: `<tool>.json` with the
// outcome of every candidate, and `<tool>.patch` when one was chosen.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { auditLane, discardLab, discoverTool } from "../audit.ts";
import type { CrashtestConfig } from "../config.ts";
import { discover } from "../discover.ts";
import { EngineError } from "../errors.ts";
import { freeTextFields, identityFields } from "../inputs.ts";
import { createLab } from "../lab.ts";
import { runLane } from "../lane.ts";
import { applyOverlay } from "../overlay.ts";
import type { GitFacts } from "../report/build.ts";
import { starString } from "../report/format.ts";
import type { Report, ToolInfo, ToolRating, VerdictKind } from "../types.ts";
import { applyLedgerGuard, applyUpstreamKey, insideApp, type CodemodFile, type CodemodResult } from "./codemod.ts";

export type Strategy = "upstream-key" | "ledger-guard";

export interface FixCandidate {
  strategy: Strategy;
  /** Whether the codemod changed the lab copy. */
  applied: boolean;
  /** Why the codemod did not apply, or why its lane could not run. */
  reason?: string;
  /** The tool's rating on the patched lab copy. */
  after?: ToolRating;
  /** What the codemod changed, with app-relative posix paths. */
  files?: CodemodResult["files"];
  /** The runs and the wall time of the candidate's lane, and the eve version of its lab. */
  runs?: number;
  wallMs?: number;
  eveVersion?: string;
}

export interface FixOutcome {
  tool: string;
  /** The input fields the op-key is built from. */
  identity: string[];
  before: ToolRating;
  candidates: FixCandidate[];
  chosen: FixCandidate | null;
  /** `.crashtest/fix/<tool>.patch`, relative to the app, when a candidate was chosen. */
  patchPath: string | null;
}

export interface FixToolOptions {
  appDir: string;
  tool: string;
  config: CrashtestConfig;
  /** The fields of the op-key; default `config.identity[tool]`, else the identity fields of the tool's input schema. */
  identity?: string[];
  /** The rating to improve on; default a fresh lane. */
  before?: ToolRating;
  onProgress?: (line: string) => void;
}

/** Tried in this order: a key the provider honors leaves the tool's flow as it is; the ledger guard is the fallback. */
const STRATEGIES: readonly Strategy[] = ["upstream-key", "ledger-guard"];
const CODEMODS: Record<Strategy, (appDir: string, tool: ToolInfo, identity: string[]) => CodemodResult> = {
  "upstream-key": applyUpstreamKey,
  "ledger-guard": applyLedgerGuard,
};

/** The output directory (where `createLab` puts it by default) and the directory of the fix outputs in it. */
const OUT_DIR = ".crashtest";
const FIX_DIR = "fix";

/** How bad a cell verdict is. A candidate may not make any cell worse than it was. */
const SEVERITY: Record<VerdictKind, number> = { clean: 0, "phantom-failure": 1, "lost-effect": 1, dup: 2, invalid: 3 };

export function isVerdictKind(value: unknown): value is VerdictKind {
  return typeof value === "string" && Object.hasOwn(SEVERITY, value);
}

/**
 * Whether `after` is better than `before`: more stars (a rating that is not evaluated never compares) and no cell
 * worse than before. A cell that only one of the two ratings has is not compared.
 */
export function isImprovement(before: ToolRating, after: ToolRating): boolean {
  if (before.stars === null || after.stars === null || after.stars <= before.stars) return false;
  const was = new Map(before.cells.map((cell) => [cell.cellId, SEVERITY[cell.kind]]));
  return after.cells.every((cell) => {
    const severity = was.get(cell.cellId);
    return severity === undefined || SEVERITY[cell.kind] <= severity;
  });
}

/**
 * Tries every strategy on its own lab copy of the app and chooses the improving candidate with the most stars (on a
 * tie, the earlier strategy). A tool rated 5 stars or not evaluated returns without candidates and writes nothing;
 * otherwise `<tool>.json` is written, and `<tool>.patch` when a candidate was chosen. Each lab is removed after its lane.
 */
export async function fixTool(o: FixToolOptions): Promise<FixOutcome> {
  const progress = o.onProgress;
  let before = o.before;
  let tool: ToolInfo | undefined;
  if (before === undefined) {
    const audited = await auditLane({ appDir: o.appDir, tool: o.tool, config: o.config, onProgress: progress });
    before = audited.lane.rating;
    tool = audited.tool;
  }
  progress?.(`[crashtest] ${o.tool} before the fix: ${ratingText(before)}`);
  if (before.stars === null || before.stars === 5) {
    return { tool: o.tool, identity: [...(o.identity ?? before.identity)], before, candidates: [], chosen: null, patchPath: null };
  }

  tool ??= (await discoverTool({ appDir: o.appDir, tool: o.tool, config: o.config, onProgress: progress })).tool;
  const identity = [...(o.identity ?? identityOf(tool, o.config))];
  const appDir = resolve(o.appDir);
  const outDir = join(appDir, OUT_DIR);
  const candidates: FixCandidate[] = [];
  for (const strategy of STRATEGIES) {
    candidates.push(await tryCandidate(strategy, { appDir, outDir, tool, identity, config: o.config, onProgress: progress }));
  }
  const chosen = choose(before, candidates);
  const outcome: FixOutcome = {
    tool: tool.name,
    identity,
    before,
    candidates,
    chosen,
    patchPath: chosen === null ? null : `${OUT_DIR}/${FIX_DIR}/${tool.name}.patch`,
  };
  writeOutcome(outDir, outcome);
  return outcome;
}

/** The op-key fields when none are given: `config.identity[tool]`, else what the lane reports as the tool's identity. */
function identityOf(tool: ToolInfo, config: CrashtestConfig): string[] {
  const own = <T>(entries: Record<string, T> | undefined): T | undefined =>
    entries !== undefined && Object.hasOwn(entries, tool.name) ? entries[tool.name] : undefined;
  const freeText = freeTextFields(tool.inputSchema, own(config.scenarios)?.freeText);
  return identityFields(tool.inputSchema, freeText, own(config.identity));
}

interface CandidateOptions {
  appDir: string;
  outDir: string;
  tool: ToolInfo;
  identity: string[];
  config: CrashtestConfig;
  onProgress?: (line: string) => void;
}

/** Applies one codemod to a fresh lab copy at `<outDir>/lab-fix-<strategy>` and runs the tool's lane there. */
async function tryCandidate(strategy: Strategy, o: CandidateOptions): Promise<FixCandidate> {
  const { tool, onProgress: progress } = o;
  const lab = createLab(o.appDir, { outDir: o.outDir, labDir: join(o.outDir, `lab-fix-${strategy}`) });
  try {
    const codemod = CODEMODS[strategy](lab.labDir, tool, o.identity);
    if (!codemod.applied) {
      const reason = codemod.reason ?? "not applied";
      progress?.(`[crashtest] ${tool.name} ${strategy}: not applied, ${reason}`);
      return { strategy, applied: false, reason };
    }
    const { files } = codemod;
    const notRun = (reason: string): FixCandidate => {
      progress?.(`[crashtest] ${tool.name} ${strategy}: ${reason}`);
      return { strategy, applied: true, reason, files };
    };
    progress?.(`[crashtest] ${tool.name} ${strategy}: applied to ${files.map((file) => file.path).join(", ")} in the lab`);
    applyOverlay(lab.labDir);
    let patched: ToolInfo | undefined;
    try {
      patched = (await discover(lab, o.config)).tools.find((found) => found.name === tool.name);
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      return notRun(`eve info failed on the patched lab: ${err.message.split("\n")[0]}`);
    }
    if (patched === undefined) return notRun(`eve info does not list ${tool.name} in the patched lab`);
    const lane = await runLane({ lab, tool: patched, config: o.config, onProgress: progress });
    progress?.(`[crashtest] ${tool.name} ${strategy}: ${ratingText(lane.rating)} in lab, ${lane.runs} runs`);
    return { strategy, applied: true, files, after: lane.rating, runs: lane.runs, wallMs: lane.wallMs, eveVersion: lab.eveVersion };
  } finally {
    discardLab(lab, progress);
  }
}

/** The improving candidate with the most stars; on a tie the earlier one. */
function choose(before: ToolRating, candidates: FixCandidate[]): FixCandidate | null {
  let chosen: FixCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.after === undefined || !isImprovement(before, candidate.after)) continue;
    if (chosen === null || (candidate.after.stars ?? 0) > (chosen.after?.stars ?? 0)) chosen = candidate;
  }
  return chosen;
}

function writeOutcome(outDir: string, outcome: FixOutcome): void {
  const dir = join(outDir, FIX_DIR);
  mkdirSync(dir, { recursive: true });
  const patch = join(dir, `${outcome.tool}.patch`);
  // A patch left by an earlier run would contradict this outcome.
  if (outcome.chosen === null) rmSync(patch, { force: true });
  else writeFileSync(patch, patchOf(outcome.chosen.files ?? []));
  writeFileSync(join(dir, `${outcome.tool}.json`), `${JSON.stringify(outcome, null, 2)}\n`);
}

/** A unified diff of the files, `a/<path>` to `b/<path>` (a new file from `/dev/null`), that `git apply` takes. */
export function patchOf(files: CodemodFile[]): string {
  return files
    .map((file) =>
      createTwoFilesPatch(file.before === null ? "/dev/null" : `a/${file.path}`, `b/${file.path}`, file.before ?? "", file.after, undefined, undefined, {
        headerOptions: FILE_HEADERS_ONLY,
      }),
    )
    .join("");
}

/**
 * Writes the chosen candidate's files into the source app. Every file must still be what the fix was made from (a
 * file the fix creates must not exist yet) and every path must stay inside the app; otherwise nothing is written.
 */
export function applyFix(appDir: string, outcome: FixOutcome): void {
  const files = outcome.chosen?.files ?? [];
  const root = resolve(appDir);
  const targets = files.map((file) => ({ file, target: targetIn(root, file.path, outcome.tool) }));
  for (const { file, target } of targets) {
    const current = readIfExists(target, file.path, outcome.tool);
    if (file.before === null && current !== null) {
      throw new EngineError(`cannot apply the fix for ${outcome.tool}: ${file.path} already exists; nothing was written`);
    }
    if (file.before !== null && current !== file.before) {
      throw new EngineError(`cannot apply the fix for ${outcome.tool}: ${file.path} changed since the fix was made; nothing was written`);
    }
  }
  // New files first, so a tool file never imports a helper that is not there yet.
  for (const { file, target } of targets.toSorted((a, b) => Number(a.file.before !== null) - Number(b.file.before !== null))) {
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.after);
    } catch (err) {
      throw new EngineError(`cannot apply the fix for ${outcome.tool}: cannot write ${file.path} (${(err as Error).message})`);
    }
  }
}

/** The absolute path of an app-relative posix path, which must name a file inside the app. */
function targetIn(root: string, path: string, tool: string): string {
  const segments = path.split("/");
  const plain = path !== "" && !path.includes("\\") && !posix.isAbsolute(path) && !win32.isAbsolute(path) && !/^[A-Za-z]:/.test(path);
  const target = resolve(root, ...segments);
  if (!plain || segments.some((segment) => segment === "" || segment === "." || segment === "..") || !insideApp(root, target)) {
    throw new EngineError(`cannot apply the fix for ${tool}: ${JSON.stringify(path)} is not a path inside the app; nothing was written`);
  }
  return target;
}

function readIfExists(target: string, path: string, tool: string): string | null {
  try {
    return readFileSync(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new EngineError(`cannot apply the fix for ${tool}: cannot read ${path} (${(err as Error).message}); nothing was written`);
  }
}

/**
 * The report's ratings by tool when they describe the code the app has now: the report was made on a clean tree at
 * the commit the app is at, and the app has no uncommitted changes (`app` is `readGit` of the app); otherwise why not.
 * Only a report whose `target.dirty` is `false` counts as made on a clean tree.
 */
export function usableRatings(report: Report, app: GitFacts): { ratings: Map<string, ToolRating> } | { unusable: string } {
  const made = report.target.commit;
  const dirty: unknown = report.target.dirty;
  if (made === null) return { unusable: "it records no commit" };
  if (app.commit === null) return { unusable: "the app has no git commit to compare it with" };
  if (made !== app.commit) return { unusable: `it was made at commit ${made} and the app is at ${app.commit}` };
  if (dirty === true) return { unusable: "it was made on uncommitted changes" };
  if (dirty !== false) return { unusable: "it does not record whether it was made on uncommitted changes" };
  if (app.dirty) return { unusable: "the app has uncommitted changes now" };
  return { ratings: new Map(report.tools.map((rating) => [rating.tool, rating])) };
}

function ratingText(rating: ToolRating): string {
  return rating.stars === null ? `not evaluated (${rating.na?.reason ?? "no rating"})` : `${starString(rating.stars)} (${rating.stars}/5)`;
}

/** What `crashtest fix` prints for one tool. */
export function fixSummary(outcome: FixOutcome): string {
  const { tool, before, chosen } = outcome;
  if (before.stars === null) return `No fix attempted for ${tool}: ${ratingText(before)}.\n`;
  if (before.stars === 5) return `No fix needed for ${tool}: ${ratingText(before)} in lab.\n`;
  const after = chosen?.after?.stars;
  if (chosen === null || after === undefined || after === null) return `No candidate improved ${tool}; nothing written.\n`;
  const lines = [
    `In lab: ${tool} ${starString(before.stars)} → ${starString(after)} with ${chosen.strategy} (${chosen.runs ?? 0} runs, eve ${chosen.eveVersion ?? "unknown"}). Patch: ${outcome.patchPath}`,
  ];
  if (chosen.strategy === "ledger-guard") {
    const fields = outcome.identity.length === 0 ? "no fields" : outcome.identity.join(", ");
    lines.push(
      `Trade-off: a second legitimate call with the same identity (${fields}) in the same turn is blocked.`,
      "Store: the lab used the file store, which is for local runs only and keeps its records in .crashtest-idempotency/ in the working directory of eve dev (the app root); add that directory to .gitignore.",
      "Production requires a durable store: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis REST).",
    );
  }
  return `${lines.join("\n")}\n`;
}
