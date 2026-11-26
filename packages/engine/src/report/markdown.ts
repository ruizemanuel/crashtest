// Renders a report as the Markdown comment: what already holds up first, then the findings worst first, then what
// could not be evaluated, with the per-cell evidence folded away.
import { cellLabel } from "../matrix.ts";
import type { CellVerdict, Report, Stars, ToolRating } from "../types.ts";
import { commitLabel, reportDate, starString } from "./format.ts";

const LIMITS =
  "Limits: crashtest sees HTTP/1.1 requests made through fetch/http/https and node:fs writes inside the app; raw TCP, HTTP/2, gRPC and effects inside eve sandboxes are not observed.";

/** A tool that was rated, with its stars. */
type Rated = ToolRating & { stars: Stars };

const hasStars = (rating: ToolRating): rating is Rated => rating.stars !== null;
const byName = (a: ToolRating, b: ToolRating): number => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0);
const byStarsThenName = (a: Rated, b: Rated): number => a.stars - b.stars || byName(a, b);

/** Text on one line: line breaks would end a list item or a table row. */
function line(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ");
}

/** Text on one line with the characters that would end a table cell escaped. */
function cell(text: string): string {
  return line(text).replace(/\|/g, "\\|");
}

/**
 * Text that came from a tool, a provider or the config, made harmless in a comment: `<` cannot start HTML and an
 * `@` (followed by a zero-width space) cannot mention anyone.
 */
function plain(text: string): string {
  return text.replace(/</g, "&lt;").replace(/@/g, "@\u200b");
}

/** A tool name as an inline code span that a backtick in the name cannot break; in a table, `|` is escaped too. */
function code(name: string, inTable: boolean): string {
  const text = inTable ? cell(name) : line(name);
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longestRun + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

const waiver = (rating: ToolRating): string => (rating.waived === undefined ? "" : plain(` (waived: ${rating.waived})`));

function ratingHeader(r: Report): string {
  const { stars, evaluated, total } = r.agent;
  return stars === null
    ? "**Agent rating: not evaluated**"
    : `**Agent rating: ${starString(stars)} (${stars}/5)** · ${evaluated} of ${total} tools evaluated`;
}

function holdsUp(tools: Rated[]): string[] {
  if (tools.length === 0) return [];
  const items = tools.map((tool) => `- ${code(tool.tool, false)} ${starString(tool.stars)}${line(waiver(tool))} — ${line(plain(tool.summary))}`);
  return [`### What already holds up\n\n${items.join("\n")}`];
}

function findings(tools: Rated[]): string[] {
  if (tools.length === 0) return [];
  const rows = tools.map(
    (tool) =>
      `| ${code(tool.tool, true)} | ${starString(tool.stars)}${cell(waiver(tool))} | ${cell(plain(tool.summary))} | ${cell(plain(tool.recommendation))} |`,
  );
  return [`### Findings\n\n| Tool | Rating | What happened | Recommendation |\n| --- | --- | --- | --- |\n${rows.join("\n")}`];
}

function notEvaluated(tools: ToolRating[]): string[] {
  if (tools.length === 0) return [];
  const items = tools.map((tool) => `- ${code(tool.tool, false)}${line(waiver(tool))} — ${line(plain(tool.summary))}`);
  return [`### Not evaluated\n\n${items.join("\n")}`];
}

function evidenceRow(verdict: CellVerdict, approval: boolean): string {
  const kind = verdict.seen === undefined ? verdict.kind : `${verdict.kind} (seen ${verdict.seen})`;
  const cells = [cellLabel(verdict.cellId, approval), kind, `${verdict.stateChanges}/${verdict.expected}`, verdict.recovery, String(verdict.attempts)];
  return `| ${cells.map(cell).join(" | ")} |`;
}

function evidence(tools: ToolRating[]): string[] {
  const tables = tools
    .filter((tool) => tool.cells.length > 0)
    .map((tool) => {
      const rows = tool.cells.map((verdict) => evidenceRow(verdict, tool.approval));
      return `**${code(tool.tool, false)}**\n\n| Cell | Verdict | Effects | Recovery | Runs |\n| --- | --- | --- | --- | --- |\n${rows.join("\n")}`;
    });
  return tables.length === 0 ? [] : [`<details><summary>Evidence</summary>\n\n${tables.join("\n\n")}\n\n</details>`];
}

export function renderMarkdown(r: Report): string {
  const rated = r.tools.filter(hasStars).sort(byStarsThenName);
  const strong = rated.filter((tool) => tool.stars === 5);
  const weak = rated.filter((tool) => tool.stars < 5);
  const unrated = r.tools.filter((tool) => !hasStars(tool)).sort(byName);

  const blocks = [
    "## Crashtest report",
    `In lab: ${r.lab.cells} cells · eve ${r.eve.version} · commit ${commitLabel(r.target)} · ${reportDate(r)}`,
    ratingHeader(r),
    ...holdsUp(strong),
    ...findings(weak),
    ...notEvaluated(unrated),
    ...evidence([...strong, ...weak, ...unrated]),
    `Protection mechanisms in eve ${r.eve.version}: \`replay: "never"\` ${r.eve.capabilities.replayNever ? "available" : "not available"}.`,
    LIMITS,
  ];
  return `${blocks.join("\n\n")}\n`;
}
