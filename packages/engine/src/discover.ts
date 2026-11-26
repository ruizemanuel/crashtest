// Discovery asks eve itself which tools an overlaid lab has and what their input schemas are, so the
// engine never parses the user's TypeScript. Authored tools are the files in `agent/tools/`: `eve info`
// also lists framework default tools (bash, read_file, ...) that are not the user's to test.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CrashtestConfig } from "./config.ts";
import { EngineError } from "./errors.ts";
import { labEnv, type Lab } from "./lab.ts";
import type { EveFacts, JsonSchema, ToolInfo } from "./types.ts";

export interface Discovery {
  tools: ToolInfo[];
  skipped: { name: string; reason: string }[];
  eve: EveFacts;
}

/** The model name the overlay's scripted mock reports; anything else means the overlay did not take effect. */
const OVERLAID_MODEL = "crashtest/crashtest-script";

const INFO_TIMEOUT_MS = 120_000;
const TOOL_FILE = /\.(ts|mts|js|mjs)$/;
const NOT_A_TOOL = /\.(spec|test)\./;
const REPLAY_NEVER = /\breplay\?:\s*["']never["']/;
const TAIL_CHARS = 2000;

interface EveInfo {
  status?: unknown;
  diagnostics?: { errors?: unknown; warnings?: unknown };
  model?: unknown;
  tools?: unknown;
  toolInputSchemas?: { root?: Record<string, unknown> };
}

/** Which tools the lab has, which authored files eve did not pick up, and what the installed eve can do. */
export async function discover(lab: Lab, config: CrashtestConfig): Promise<Discovery> {
  const info = readEveInfo(lab);
  const listed = new Set(Array.isArray(info.tools) ? info.tools.filter((t): t is string => typeof t === "string") : []);
  const excluded = new Set(config.tools?.exclude ?? []);
  const schemas = info.toolInputSchemas?.root ?? {};

  const tools: ToolInfo[] = [];
  const skipped = new Map<string, string>();
  for (const { name, file } of authoredTools(lab.labDir)) {
    if (excluded.has(name)) continue; // reported below with the rest of the exclude list
    if (!listed.has(name)) skipped.set(name, "not listed by eve info");
    else tools.push({ name, file, inputSchema: asSchema(schemas[name]) });
  }
  for (const name of excluded) skipped.set(name, "excluded by config");

  return {
    tools: tools.sort(byName),
    skipped: [...skipped].map(([name, reason]) => ({ name, reason })).sort(byName),
    eve: { version: lab.eveVersion, capabilities: { replayNever: declaresReplayNever(lab.eveBin) } },
  };
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Top-level files of `agent/tools/` that eve treats as tools: no spec or test files. Name = file name without its extension. */
function authoredTools(labDir: string): { name: string; file: string }[] {
  const dir = join(labDir, "agent", "tools");
  if (!existsSync(dir)) return [];
  const found = new Map<string, string>();
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && TOOL_FILE.test(e.name) && !NOT_A_TOOL.test(e.name));
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = entry.name.replace(TOOL_FILE, "");
    if (!found.has(name)) found.set(name, `agent/tools/${entry.name}`);
  }
  return [...found].map(([name, file]) => ({ name, file }));
}

function asSchema(value: unknown): JsonSchema | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonSchema) : null;
}

/**
 * Runs `eve info --json` in the lab and checks that the overlay took effect and that eve found no errors.
 * CLI telemetry is off: discovery runs without the preload, so eve would send it for real, from a detached
 * flush process that outlives `eve info` with the lab as its working directory (on Windows the lab then cannot be wiped).
 */
function readEveInfo(lab: Lab): EveInfo {
  const result = spawnSync(process.execPath, [lab.eveBin, "info", "--json"], {
    cwd: lab.labDir,
    env: labEnv(process.env, { EVE_TELEMETRY_DISABLED: "1" }),
    encoding: "utf8",
    timeout: INFO_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const why = code === "ETIMEDOUT" ? `did not finish within ${INFO_TIMEOUT_MS / 1000} s` : `could not run (${result.error.message})`;
    throw new EngineError(`eve info ${why} in ${lab.labDir}${tail(output)}`);
  }

  const info = parseInfo(result.stdout ?? "");
  if (info === null) {
    throw new EngineError(`eve info printed no JSON object (exit code ${result.status}) in ${lab.labDir}${tail(output)}`);
  }

  const problems: string[] = [];
  if (info.status !== "ready") problems.push(`status is ${JSON.stringify(info.status)}, expected "ready"`);
  const errors = info.diagnostics?.errors;
  if (typeof errors !== "number") problems.push("diagnostics are missing");
  else if (errors !== 0) problems.push(`diagnostics report ${errors} error${errors === 1 ? "" : "s"}, expected 0`);
  if (info.model !== OVERLAID_MODEL) problems.push(`model is ${JSON.stringify(info.model)}, expected "${OVERLAID_MODEL}": the overlay did not take effect`);
  if (problems.length > 0) throw new EngineError(`eve info does not describe a usable lab in ${lab.labDir}: ${problems.join("; ")}${tail(output)}`);
  return info;
}

/** The JSON object in `eve info` stdout; lines before or after it (warnings, banners) are tolerated. */
function parseInfo(stdout: string): EveInfo | null {
  const first = stdout.indexOf("{");
  const last = stdout.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(first, last + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as EveInfo) : null;
  } catch {
    return null;
  }
}

function tail(output: string): string {
  const text = output.trim();
  if (text === "") return "";
  return `\n--- output tail ---\n${text.length > TAIL_CHARS ? `...${text.slice(-TAIL_CHARS)}` : text}`;
}

const replayNeverByDist = new Map<string, boolean>();

/** Whether the installed eve declares `replay?: "never"` in its type definitions (a per-tool opt out of replay). */
function declaresReplayNever(eveBin: string): boolean {
  const dist = join(eveRoot(eveBin), "dist");
  const known = replayNeverByDist.get(dist);
  if (known !== undefined) return known;
  let found = false;
  if (existsSync(dist)) {
    for (const rel of readdirSync(dist, { recursive: true, encoding: "utf8" })) {
      if (!/\.d\.[cm]?ts$/.test(rel)) continue;
      if (REPLAY_NEVER.test(readFileSync(join(dist, rel), "utf8"))) {
        found = true;
        break;
      }
    }
  }
  replayNeverByDist.set(dist, found);
  return found;
}

/** The package directory of eve: the nearest directory above its binary that has a package.json. */
function eveRoot(eveBin: string): string {
  let dir = dirname(eveBin);
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}
