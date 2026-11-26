#!/usr/bin/env node
// The `crashtest` command line. Every argument is parsed and checked before any lab work starts. Exit codes: 0 done,
// 1 an engine or config error or an agent rating below `--min-stars`, 2 a usage error, 130 interrupted (SIGINT).
// stdout carries only results (`--json` or the final summary); progress and errors go to stderr.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { audit, auditLane, planAudit, reportFiles, type AuditPlan } from "./audit.ts";
import { loadConfig } from "./config.ts";
import { killAllTracked } from "./driver/process.ts";
import { ConfigError, EngineError } from "./errors.ts";
import { engineVersion } from "./paths.ts";
import { renderBadge } from "./report/badge.ts";
import { commitLabel, starString } from "./report/format.ts";
import type { EveFacts, LaneResult, Report, Stars } from "./types.ts";

const USAGE = `crashtest ${engineVersion} - crash-test ratings for eve agents

Usage: crashtest <command> [options]

Commands:
  plan     discover the agent's tools and plan the crash cells
  run      crash-test every tool and write the report
  lane     crash-test a single tool
  fix      propose a fix for a failing tool (not available yet)
  badge    render a rating badge from a report

Command options:
  plan   [--app <dir>] [--config <file>] [--json]
  lane   --tool <name> [--app <dir>] [--config <file>] [--json] [--keep-lab]
  run    [--app <dir>] [--config <file>] [--tools <a,b>] [--install] [--keep-lab] [--min-stars <1-5>]
  badge  [--report <file>] [--out <file>]

  --app defaults to the current directory, --report to .crashtest/report.json and --out
  to badge.svg next to the report. Results describe the lab run, not production.

Options:
  --version  print the version
  --help     print this help
`;

/** The options each command accepts: those that take a value, and the switches. */
const OPTIONS = {
  plan: { values: ["app", "config"], switches: ["json"] },
  lane: { values: ["app", "config", "tool"], switches: ["json", "keep-lab"] },
  run: { values: ["app", "config", "tools", "min-stars"], switches: ["install", "keep-lab"] },
  badge: { values: ["report", "out"], switches: [] },
} as const satisfies Record<string, { values: readonly string[]; switches: readonly string[] }>;

type CommandName = keyof typeof OPTIONS;

type Command =
  | { name: "plan"; app: string; config: string | undefined; json: boolean }
  | { name: "lane"; app: string; config: string | undefined; tool: string; json: boolean; keepLab: boolean }
  | { name: "run"; app: string; config: string | undefined; tools: string[] | undefined; install: boolean; keepLab: boolean; minStars: Stars | undefined }
  | { name: "badge"; report: string; out: string };

/** A problem with the command line itself: exit 2. */
class UsageError extends Error {}

interface Flags {
  values: Map<string, string>;
  switches: Set<string>;
}

function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(OPTIONS, name);
}

/** `--name value`, `--name=value` and `--switch`; anything else, a repeat or a missing value is a usage error. */
function parseFlags(command: CommandName, args: string[]): Flags {
  const valueNames: readonly string[] = OPTIONS[command].values;
  const switchNames: readonly string[] = OPTIONS[command].switches;
  const flags: Flags = { values: new Map(), switches: new Set() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument "${arg}" for ${command}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flags.values.has(name) || flags.switches.has(name)) throw new UsageError(`--${name} is given twice`);
    if (switchNames.includes(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags.switches.add(name);
    } else if (valueNames.includes(name)) {
      let value = inline;
      if (value === undefined) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          value = next;
          i += 1;
        }
      }
      if (value === undefined || value.trim() === "") throw new UsageError(`--${name} needs a value`);
      flags.values.set(name, value);
    } else {
      throw new UsageError(`unknown option --${name} for ${command}`);
    }
  }
  return flags;
}

function minStarsOf(value: string | undefined): Stars | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-5]$/.test(value)) throw new UsageError(`--min-stars must be an integer from 1 to 5, got "${value}"`);
  return Number(value) as Stars;
}

function toolListOf(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) throw new UsageError("--tools needs at least one tool name");
  return names;
}

function parseCommand(name: CommandName, args: string[]): Command {
  const flags = parseFlags(name, args);
  const value = (key: string): string | undefined => flags.values.get(key);
  const on = (key: string): boolean => flags.switches.has(key);
  const app = resolve(value("app") ?? ".");
  switch (name) {
    case "plan":
      return { name, app, config: value("config"), json: on("json") };
    case "lane": {
      const tool = value("tool");
      if (tool === undefined) throw new UsageError("lane needs --tool <name>");
      return { name, app, config: value("config"), tool, json: on("json"), keepLab: on("keep-lab") };
    }
    case "run":
      return {
        name,
        app,
        config: value("config"),
        tools: toolListOf(value("tools")),
        install: on("install"),
        keepLab: on("keep-lab"),
        minStars: minStarsOf(value("min-stars")),
      };
    case "badge": {
      const report = resolve(value("report") ?? reportFiles(".crashtest").json);
      return { name, report, out: resolve(value("out") ?? reportFiles(dirname(report)).badge) };
    }
  }
}

function progress(line: string): void {
  process.stderr.write(`${line}\n`);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ratingText(stars: Stars | null): string {
  return stars === null ? "not evaluated" : `${starString(stars)} (${stars}/5)`;
}

function duration(seconds: number): string {
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function planText(plan: AuditPlan): string {
  const cells = plan.tools.reduce((sum, tool) => sum + tool.cells.length, 0);
  const lines = [`eve ${plan.eve.version} · replay: "never" ${plan.eve.capabilities.replayNever ? "available" : "not available"}`];
  lines.push(plan.tools.length === 0 ? "No tools to crash-test." : `Tools to crash-test: ${plan.tools.map((tool) => tool.name).join(", ")}`);
  for (const skip of plan.skipped) lines.push(`Skipped ${skip.name}: ${skip.reason}`);
  lines.push(`Plan: ${cells} cells, about ${duration(plan.estimatedSeconds)} before confirmation runs`);
  return `${lines.join("\n")}\n`;
}

function laneLine(lane: LaneResult, eve: EveFacts): string {
  const reason = lane.rating.na === undefined ? "" : ` (${lane.rating.na.reason})`;
  return `${lane.tool}: ${ratingText(lane.rating.stars)}${reason} · In lab: ${lane.runs} cells · eve ${eve.version}\n`;
}

function agentLine(r: Report): string {
  const { stars, evaluated, total } = r.agent;
  return `Agent rating: ${ratingText(stars)} · ${evaluated} of ${total} tools evaluated · In lab: ${r.lab.cells} cells · eve ${r.eve.version} · commit ${commitLabel(r.target)}\n`;
}

/** Why the agent misses `--min-stars`, or null when it meets the bar. Not evaluated counts as below it. */
function belowBar(r: Report, minStars: Stars | undefined): string | null {
  if (minStars === undefined) return null;
  const { stars } = r.agent;
  if (stars === null) return `the agent was not evaluated, which counts as below --min-stars ${minStars}`;
  return stars < minStars ? `the agent rating ${stars}/5 is below --min-stars ${minStars}` : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enough of a report for the badge: the fields it reads, with stars that are null or 1 to 5. */
function isReport(value: unknown): value is Report {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.createdAt !== "string") return false;
  const { agent, eve, lab, target } = value;
  const stars = isObject(agent) ? agent.stars : undefined;
  return (
    (stars === null || (typeof stars === "number" && Number.isInteger(stars) && stars >= 1 && stars <= 5)) &&
    isObject(eve) &&
    typeof eve.version === "string" &&
    isObject(lab) &&
    typeof lab.cells === "number" &&
    isObject(target) &&
    (target.commit === null || typeof target.commit === "string")
  );
}

function readReport(path: string): Report {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "file not found" : (err as Error).message;
    throw new EngineError(`cannot read the report ${path}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new EngineError(`${path} is not valid JSON (${(err as Error).message})`);
  }
  if (!isReport(parsed)) throw new EngineError(`${path} is not a crashtest report (schemaVersion 1)`);
  return parsed;
}

async function execute(c: Command): Promise<number> {
  switch (c.name) {
    case "plan": {
      const plan = await planAudit({ appDir: c.app, config: loadConfig(c.app, c.config), onProgress: progress });
      process.stdout.write(c.json ? json(plan) : planText(plan));
      return 0;
    }
    case "lane": {
      const config = loadConfig(c.app, c.config);
      const { lane, eve } = await auditLane({ appDir: c.app, tool: c.tool, config, keepLab: c.keepLab, onProgress: progress });
      process.stdout.write(c.json ? json(lane) : laneLine(lane, eve));
      return 0;
    }
    case "run": {
      const config = loadConfig(c.app, c.config);
      const { report, files } = await audit({ appDir: c.app, tools: c.tools, config, install: c.install, keepLab: c.keepLab, onProgress: progress });
      process.stdout.write(`Report: ${files.markdown}\n${agentLine(report)}`);
      const miss = belowBar(report, c.minStars);
      if (miss === null) return 0;
      process.stderr.write(`crashtest: ${miss}\n`);
      return 1;
    }
    case "badge": {
      const report = readReport(c.report);
      try {
        mkdirSync(dirname(c.out), { recursive: true });
        writeFileSync(c.out, renderBadge(report));
      } catch (err) {
        throw new EngineError(`cannot write the badge ${c.out}: ${(err as Error).message}`);
      }
      process.stdout.write(`${c.out}\n`);
      return 0;
    }
  }
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "--version") {
    process.stdout.write(`${engineVersion}\n`);
    return 0;
  }
  if (command === undefined || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!isCommandName(command)) {
    process.stderr.write(`crashtest: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  if (args.includes("--help")) {
    process.stdout.write(USAGE);
    return 0;
  }

  let parsed: Command;
  try {
    parsed = parseCommand(command, args);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`crashtest: ${err.message}\nRun "crashtest --help" for usage.\n`);
    return 2;
  }
  try {
    return await execute(parsed);
  } catch (err) {
    if (!(err instanceof EngineError || err instanceof ConfigError)) throw err;
    process.stderr.write(`crashtest: ${err.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  // Ctrl-C: on POSIX every `eve dev` leads its own process group, so it would outlive the CLI unless killed here.
  process.on("SIGINT", () => {
    killAllTracked();
    process.exit(130);
  });
  process.exitCode = await main(process.argv.slice(2));
}
