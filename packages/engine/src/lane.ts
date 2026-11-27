// Runs every cell of one tool, called a lane: two baselines, then the four crash cells, then rates the tool.
// An invalid cell is run once more; a cell that shows anything other than clean is confirmed 2 of 3 so that a
// single flaky run never decides a rating.
import type { CrashtestConfig } from "./config.ts";
import { analyzeCell, baselineFacts, mutatingEntries } from "./detect.ts";
import { runCell, type RunCellOptions } from "./driver/run-cell.ts";
import { freeTextFields, identityFields, sampleInput } from "./inputs.ts";
import type { Lab } from "./lab.ts";
import { cellLabel, CORE_CELLS, crashCells } from "./matrix.ts";
import { rateTool } from "./rate.ts";
import type { Cell, CellVerdict, LaneResult, RunSummary, ToolInfo, VerdictKind } from "./types.ts";

export interface LaneOptions {
  lab: Lab;
  tool: ToolInfo;
  config: CrashtestConfig;
  /** Runs one cell (default: the real runner); tests script it. */
  runner?: (o: RunCellOptions) => Promise<RunSummary>;
  onProgress?: (line: string) => void;
}

/** A config entry of this tool only: a tool called `constructor` must not pick up `Object.prototype`. */
function ownEntry<T>(entries: Record<string, T> | undefined, key: string): T | undefined {
  return entries !== undefined && Object.hasOwn(entries, key) ? entries[key] : undefined;
}

function baselineCell(id: "baseline-1" | "baseline-2"): Cell {
  const cell = CORE_CELLS.find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`the matrix has no cell ${id}`);
  return cell;
}

function seconds(run: RunSummary): string {
  return (run.wallMs / 1000).toFixed(1);
}

/**
 * What the confirmation runs of a cell come to: the kind seen at least twice, else clean. When the runs all differ
 * and none of them is clean, there is no verdict to stand on and no clean run to fall back to: the cell is invalid
 * (and the tool not evaluable) rather than rated on a finding nobody could reproduce.
 */
function settle(verdicts: CellVerdict[], attempts: number): CellVerdict {
  const [first] = verdicts;
  if (first === undefined) throw new Error("settle needs at least one verdict");
  const kinds = verdicts.map((verdict) => verdict.kind);
  const timesSeen = (kind: VerdictKind): number => kinds.filter((candidate) => candidate === kind).length;
  const kind = kinds.find((candidate) => timesSeen(candidate) >= 2) ?? "clean";
  // `seen` says how often the finding that triggered the confirmation came back, out of the runs that judged it.
  const seen = `${timesSeen(kind === "clean" ? first.kind : kind)} of ${verdicts.length}`;
  const chosen = verdicts.find((verdict) => verdict.kind === kind);
  if (chosen !== undefined) return { ...chosen, attempts, seen };

  const basis = verdicts.find((verdict) => verdict.kind === "invalid") ?? first;
  const { dupClass: _dupClass, ...rest } = basis;
  return { ...rest, kind: "invalid", attempts, seen, invalidReason: `unconfirmed: ${kinds.join(", ")}` };
}

export async function runLane(o: LaneOptions): Promise<LaneResult> {
  const t0 = Date.now();
  const run = o.runner ?? runCell;
  const { tool, config } = o;
  const schema = tool.inputSchema;
  const scenario = ownEntry(config.scenarios, tool.name);
  const input = scenario?.input ?? sampleInput(schema);
  const freeText = freeTextFields(schema, scenario?.freeText);
  const identity = identityFields(schema, freeText, ownEntry(config.identity, tool.name));
  const waiver = ownEntry(config.waivers, tool.name);
  let runs = 0;

  const execute = (cell: Cell, attempt: number): Promise<RunSummary> => {
    runs += 1;
    return run({ lab: o.lab, tool, cell, attempt, input, freeTextFields: freeText, config, ...(o.onProgress ? { onProgress: o.onProgress } : {}) });
  };
  const report = (cell: Cell, approval: boolean, outcome: string, effects: string, result: RunSummary): void =>
    o.onProgress?.(`[crashtest] ${tool.name} ${cellLabel(cell.id, approval)} -> ${outcome} (${effects} effects, ${seconds(result)}s)`);
  const runBaseline = async (id: "baseline-1" | "baseline-2"): Promise<RunSummary> => {
    const cell = baselineCell(id);
    const result = await execute(cell, 1);
    report(cell, false, result.turnOutcome, String(mutatingEntries(result, config).filter((entry) => entry.stateChange).length), result);
    return result;
  };

  const b1 = await runBaseline("baseline-1");
  const b2 = await runBaseline("baseline-2");

  const approval = b1.approvals > 0;
  const base = baselineFacts(tool.name, b1, b2, config);
  if (!base.ok) {
    const na = { reason: base.reason, detail: base.detail };
    const rating = rateTool({ tool: tool.name, approval, cells: [], identity, na, ...(waiver !== undefined ? { waiver } : {}) });
    return { tool: tool.name, rating, runs, wallMs: Date.now() - t0 };
  }

  const cells: CellVerdict[] = [];
  for (const cell of crashCells()) {
    let attempt = 0;
    const judge = async (): Promise<CellVerdict> => {
      attempt += 1;
      const result = await execute(cell, attempt);
      const verdict = analyzeCell(cell, result, base, config);
      report(cell, base.approval, verdict.kind, `${verdict.stateChanges}/${verdict.expected}`, result);
      return verdict;
    };

    let verdict = await judge();
    if (verdict.kind === "invalid") verdict = await judge();
    if (verdict.kind === "clean" || verdict.kind === "invalid") {
      cells.push({ ...verdict, attempts: attempt });
      continue;
    }
    const second = await judge();
    const verdicts = [verdict, second];
    if (second.kind !== verdict.kind) verdicts.push(await judge());
    cells.push(settle(verdicts, attempt));
  }

  const rating = rateTool({ tool: tool.name, approval: base.approval, cells, identity, ...(waiver !== undefined ? { waiver } : {}) });
  return { tool: tool.name, rating, runs, wallMs: Date.now() - t0 };
}
