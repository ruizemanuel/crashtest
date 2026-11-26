// Small formatting helpers shared by the Markdown report and the badge, so both say the same thing the same way.
import type { Report, Stars } from "../types.ts";

/** `★` repeated `stars` times, padded with `☆` up to five. */
export function starString(stars: Stars): string {
  return "★".repeat(stars) + "☆".repeat(5 - stars);
}

/** The commit the report was made from: the sha, `sha+dirty` with uncommitted changes, or `no commit`. */
export function commitLabel(target: Report["target"]): string {
  if (target.commit === null) return "no commit";
  return target.dirty ? `${target.commit}+dirty` : target.commit;
}

/** `YYYY-MM-DD` of the moment the report was created. */
export function reportDate(report: Report): string {
  return report.createdAt.slice(0, 10);
}
