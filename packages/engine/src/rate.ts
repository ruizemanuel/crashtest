// Turns the verdicts of a tool's cells into its star rating and the fixed report copy, then the tool ratings into
// the agent's rating. Pure: the copy below is the product's wording, not generated text.
import { REDACTED_FIELD, hostOfEndpoint } from "./detect.ts";
import { crashCells } from "./matrix.ts";
import { hostSupportsIdempotency, hostSupportsLookup } from "./preload/catalog.ts";
import type { CellVerdict, EffectEvidence, NaReason, Stars, ToolRating } from "./types.ts";

interface RateInput {
  tool: string;
  approval: boolean;
  cells: CellVerdict[];
  identity: string[];
  na?: { reason: NaReason; detail: string };
  waiver?: string;
}

const NA_SUMMARY: Record<NaReason, (detail: string) => string> = {
  "no-effect": () => "No external effect observed in the baseline.",
  "baseline-failed": (detail) => `The baseline run failed: ${detail}`,
  "baseline-unstable": (detail) => `The two baseline runs produced different effects: ${detail}`,
  "cells-invalid": (detail) => `Some crash cells could not be evaluated: ${detail}`,
  "not-discovered": () => "eve did not list this tool.",
};

const UNCERTAIN_RECOMMENDATION =
  "No duplicates, but after recovery the model sees a misleading result. Return an explicit uncertain-outcome error (`OUTCOME_UNKNOWN`) instead of a generic failure.";

const LOOKUP_HINT = " The provider supports a lookup, so the tool can also check whether the effect already happened before acting.";

/** How much of a tool's error text the summary quotes; the rest would only make the report unreadable. */
const ERROR_QUOTE_CHARS = 200;

/** The first `ERROR_QUOTE_CHARS` characters of an error, with `…` appended when the text was longer. */
function quoteError(error: string): string {
  const chars = [...error];
  return chars.length <= ERROR_QUOTE_CHARS ? error : `${chars.slice(0, ERROR_QUOTE_CHARS).join("")}…`;
}

function excess(evidence: EffectEvidence | undefined): number {
  return evidence === undefined ? 0 : evidence.count - evidence.expected;
}

/** The evidence with the most effects beyond what the baseline expected, or undefined when nothing exceeds it. */
function worstEvidence(cell: CellVerdict): EffectEvidence | undefined {
  let worst: EffectEvidence | undefined;
  for (const item of cell.evidence) {
    if (excess(item) > excess(worst)) worst = item;
  }
  return worst;
}

/** The duplicate verdict the report speaks about: a stable-id one if there is any, else the worst of the rest. */
function headlineDup(dups: CellVerdict[]): { cell: CellVerdict; evidence: EffectEvidence | undefined } {
  const stable = dups.filter((cell) => cell.dupClass === "stable");
  const candidates = (stable.length > 0 ? stable : dups).map((cell) => ({ cell, evidence: worstEvidence(cell) }));
  const [first, ...rest] = candidates;
  if (first === undefined) throw new Error("headlineDup needs at least one duplicate");
  return rest.reduce((best, next) => (excess(next.evidence) > excess(best.evidence) ? next : best), first);
}

/** `` `a`, `b` ``, or null when the tool has no identity fields. */
function identityList(identity: string[]): string | null {
  return identity.length === 0 ? null : identity.map((field) => `\`${field}\``).join(", ");
}

function duplicateCopy(dups: CellVerdict[], identity: string[]): { summary: string; recommendation: string; host: string | null } {
  const { cell, evidence } = headlineDup(dups);
  const n = evidence?.count ?? cell.stateChanges;
  const e = evidence?.expected ?? cell.expected;
  const host = evidence === undefined ? null : hostOfEndpoint(evidence.endpoint);
  const fields = identityList(identity);
  const inParens = fields === null ? "" : ` (${fields})`;
  const counts = `(${n} effects, expected ${e})`;

  if (cell.dupClass === "stable") {
    const recommendation =
      host !== null && hostSupportsIdempotency(host)
        ? `Send an idempotency key built from business identity fields${inParens}, not \`ctx.callId\`.`
        : `Guard \`execute\` with an operation ledger keyed on session, turn, tool and identity fields${inParens}; report an explicit uncertain outcome when a previous attempt started but did not finish.`;
    return { summary: `Ran twice after a crash replayed the step with the same call id ${counts}.`, recommendation, host };
  }
  const summary =
    cell.dupClass === "retry"
      ? `Ran twice when the model retried a call eve reported as interrupted ${counts}.`
      : `Ran twice when the replayed call got a new id and rewritten text ${counts}.`;
  const recommendation = `The protection is tied to \`ctx.callId\`, which changes when the model re-issues the call after a crash. Key it on identity fields${inParens} instead.`;
  return { summary, recommendation, host };
}

function notEvaluable(o: RateInput, na: { reason: NaReason; detail: string }): ToolRating {
  return {
    tool: o.tool,
    stars: null,
    na,
    approval: o.approval,
    ...(o.waiver !== undefined ? { waived: o.waiver } : {}),
    benignRepeats: false,
    identity: o.identity,
    summary: NA_SUMMARY[na.reason](na.detail),
    recommendation: "",
    cells: o.cells,
  };
}

/** The crash cells that replay a call with its id: only they can show a duplicate with a stable id. */
const STABLE_ID_CELLS = crashCells()
  .filter((cell) => cell.idMode === "stable")
  .map((cell) => cell.id);

/**
 * Whether the cells that could be evaluated settle the rating whatever the invalid ones would have shown: a stable-id
 * duplicate is 1 or 2 stars in any case, and a fresh-id or retry duplicate is 3 stars once every stable-id cell could
 * be evaluated (no other cell can show a stable-id duplicate).
 */
function settledWithout(cells: CellVerdict[], dups: CellVerdict[]): boolean {
  if (dups.some((cell) => cell.dupClass === "stable")) return true;
  return dups.length > 0 && STABLE_ID_CELLS.every((id) => cells.some((cell) => cell.cellId === id && cell.kind !== "invalid"));
}

/**
 * The star rating of one tool from its cells' verdicts:
 * a duplicate with a stable id is 1 star (2 when the tool needs approval); a duplicate only with a fresh id or after
 * a retry is 3; no duplicate but a misleading result for the model (phantom failure, lost effect) is 4; else 5.
 * Invalid cells make the tool not evaluable, unless the other cells settle the rating anyway (see `settledWithout`).
 */
export function rateTool(o: RateInput): ToolRating {
  if (o.na) return notEvaluable(o, o.na);
  if (o.cells.length === 0) return notEvaluable(o, { reason: "cells-invalid", detail: "no crash cell ran" });
  const invalid = o.cells.filter((cell) => cell.kind === "invalid");
  const evaluable = o.cells.filter((cell) => cell.kind !== "invalid");
  const dups = evaluable.filter((cell) => cell.kind === "dup");
  const invalidIds = invalid.map((cell) => `${cell.cellId} (${cell.invalidReason ?? "invalid"})`).join(", ");
  if (invalid.length > 0 && !settledWithout(o.cells, dups)) return notEvaluable(o, { reason: "cells-invalid", detail: invalidIds });
  const stands = invalid.length === 0 ? "" : ` The rating stands without the cells that could not be evaluated: ${invalidIds}.`;

  const misleading = evaluable.filter((cell) => cell.kind === "phantom-failure" || cell.kind === "lost-effect");
  const benignRepeats = evaluable.some((cell) => cell.benignRepeats > 0);
  const base = {
    tool: o.tool,
    approval: o.approval,
    ...(o.waiver !== undefined ? { waived: o.waiver } : {}),
    benignRepeats,
    identity: o.identity,
    cells: o.cells,
  };

  if (dups.length > 0) {
    const copy = duplicateCopy(dups, o.identity);
    const stars: Stars = dups.some((cell) => cell.dupClass === "stable") ? (o.approval ? 2 : 1) : 3;
    const lookup = copy.host !== null && hostSupportsLookup(copy.host) ? LOOKUP_HINT : "";
    return { ...base, stars, summary: `${copy.summary}${stands}`, recommendation: `${copy.recommendation}${lookup}` };
  }
  if (misleading.length > 0) {
    const phantom = misleading.find((cell) => cell.kind === "phantom-failure");
    const summary = phantom
      ? `The effect happened once, but after recovery the model got an error: ${phantom.error === undefined ? "unknown error" : quoteError(phantom.error)}`
      : "The model got a success, but no effect reached the provider.";
    return { ...base, stars: 4, summary, recommendation: UNCERTAIN_RECOMMENDATION };
  }
  if (!benignRepeats) {
    return { ...base, stars: 5, summary: "One state change in every cell, and the model always got a truthful result.", recommendation: "No change needed." };
  }
  const summary = `One state change in every cell; repeated requests did not change provider state.${assumedKeyNote(evaluable)}${maskedNote(evaluable)}`;
  return { ...base, stars: 5, summary, recommendation: "Idempotent by nature: no change needed." };
}

/** `a`, `a and b`, `a, b and c`. */
function namedList(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What a rating that rests on idempotency keys sent to hosts the fake provider does not model must say. */
function assumedKeyNote(cells: CellVerdict[]): string {
  const hosts = [...new Set(cells.flatMap((cell) => cell.assumedKeyHosts ?? []))].sort();
  if (hosts.length === 0) return "";
  if (hosts.length === 1) {
    return ` The repeats to ${hosts[0]} reused an idempotency key, which that host is assumed to honor: the fake provider does not model it.`;
  }
  return ` The repeats to ${namedList(hosts)} reused an idempotency key, which those hosts are assumed to honor: the fake provider does not model them.`;
}

/**
 * What a rating that rests on repeated writes counted as benign because they changed only varying fields, or only a
 * redacted field, must say. True for a host the lab assumes to overwrite and for Vercel Blob, whose overwrite it models.
 */
function maskedNote(cells: CellVerdict[]): string {
  const fields = [...new Set(cells.flatMap((cell) => cell.maskedFields ?? []))].sort();
  if (fields.length === 0) return "";
  const visible = fields.filter((field) => field !== REDACTED_FIELD);
  const differences = [
    ...(visible.length === 0 ? [] : [`${namedList(visible.map((field) => `\`${field}\``))}, which ${visible.length === 1 ? "varies" : "vary"} between the baselines`]),
    ...(fields.includes(REDACTED_FIELD) ? [`${REDACTED_FIELD}, whose values the ledger does not keep`] : []),
  ];
  return ` A repeated write went to the same object and differed only in ${differences.join(", or only in ")}; the lab counts the later write as an overwrite of that object, not a second effect.`;
}

/**
 * The agent's rating: the lowest star count among its tools that were rated and not waived. `evaluated` counts
 * those tools; `total` counts every tool.
 */
export function rateAgent(ratings: ToolRating[]): { stars: Stars | null; evaluated: number; total: number } {
  const counted = ratings.flatMap((rating) => (rating.stars !== null && rating.waived === undefined ? [rating.stars] : []));
  return { stars: counted.length === 0 ? null : (Math.min(...counted) as Stars), evaluated: counted.length, total: ratings.length };
}
