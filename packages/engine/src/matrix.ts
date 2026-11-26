// The fixed set of cells every tool is run through: two baselines (no crash) and four crash cells.
import type { Cell, CellId } from "./types.ts";

export const CORE_CELLS: readonly Cell[] = [
  { id: "baseline-1", point: "none", idMode: "stable", latencyMs: 0, holdMs: 0 },
  { id: "baseline-2", point: "none", idMode: "stable", latencyMs: 0, holdMs: 0 },
  { id: "post-effect-fast-stable", point: "post-effect-fast", idMode: "stable", latencyMs: 0, holdMs: 0 },
  { id: "post-effect-fast-fresh", point: "post-effect-fast", idMode: "fresh", latencyMs: 0, holdMs: 0 },
  { id: "post-effect-slow", point: "post-effect-slow", idMode: "fresh", latencyMs: 0, holdMs: 2000 },
  { id: "post-settle", point: "post-settle", idMode: "stable", latencyMs: 2500, holdMs: 0 },
];

/** The cells that crash the server: everything except the baselines. */
export function crashCells(): Cell[] {
  return CORE_CELLS.filter((cell) => cell.point !== "none");
}

/** How a cell is named in the report. A tool that needs approval is crashed right after the approved call. */
export function cellLabel(id: CellId, approval: boolean): string {
  switch (id) {
    case "baseline-1":
      return "baseline 1";
    case "baseline-2":
      return "baseline 2";
    case "post-effect-fast-stable":
      return approval ? "approved-post-effect" : "post-effect-fast (stable id)";
    case "post-effect-fast-fresh":
      return "post-effect-fast (fresh id)";
    case "post-effect-slow":
      return "post-effect-slow + retry";
    case "post-settle":
      return "post-settle (2.5 s latency)";
  }
}
