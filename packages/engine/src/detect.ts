// Turns run summaries into facts: what a clean run looks like (baselineFacts) and what a crashed run did
// compared with it (analyzeCell). Pure: no I/O, no clock.
import type { CrashtestConfig } from "./config.ts";
import { hostInCatalog } from "./preload/catalog.ts";
import { ignoreMatcher } from "./preload/effects-ignore.ts";
import { KEY_REPLAY } from "./preload/fake-provider.ts";
import type { Cell, CellVerdict, EffectEvidence, LedgerEntry, NaReason, RunSummary, StreamCall } from "./types.ts";

export type BaselineFacts =
  | { ok: true; expected: Record<string, number>; volatileFields: string[]; approval: boolean }
  | { ok: false; reason: NaReason; detail: string };

/** What the model is told when an interrupted call may or may not have taken effect, as eve words it. */
const UNCERTAIN = /OUTCOME_UNKNOWN|TOOL_RECOVERY_REQUIRED/;
const SETTLED = new Set(["completed", "failed", "abandoned"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The host of a ledger endpoint: the text between the first space and the first `/`. */
export function hostOfEndpoint(endpoint: string): string {
  const start = endpoint.indexOf(" ") + 1;
  const slash = endpoint.indexOf("/", start);
  return endpoint.slice(start, slash === -1 ? undefined : slash);
}

// --- ledger helpers -------------------------------------------------------------------------------------------

/** The mutating ledger entries of a run, minus those the config says to ignore. Reads never count as effects. */
function mutatingEntries(run: RunSummary, config: CrashtestConfig): LedgerEntry[] {
  const ignored = ignoreMatcher(config.effects?.ignore ?? []);
  return run.ledger.filter((entry) => entry.mutating && !ignored(entry.url));
}

function groupByEndpoint(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const group = groups.get(entry.endpoint);
    if (group) group.push(entry);
    else groups.set(entry.endpoint, [entry]);
  }
  return groups;
}

/** State changes per endpoint. */
function stateChangeCounts(entries: LedgerEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.stateChange) counts.set(entry.endpoint, (counts.get(entry.endpoint) ?? 0) + 1);
  }
  return counts;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** JSON with object keys sorted, so two equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  const sorted = (_key: string, inner: unknown): unknown =>
    isRecord(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : inner;
  return JSON.stringify(value, sorted) ?? "undefined";
}

/** The top-level keys whose values differ between two request bodies; none when either is not an object. */
function differingKeys(first: unknown, second: unknown): string[] {
  if (!isRecord(first) || !isRecord(second)) return [];
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...keys].filter((key) => canonical(first[key]) !== canonical(second[key]));
}

// --- calls ----------------------------------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  if (error === undefined || error === null) return "";
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return JSON.stringify(error) ?? String(error);
}

function isUncertain(error: unknown): boolean {
  const whole = typeof error === "string" ? error : (JSON.stringify(error) ?? "");
  return UNCERTAIN.test(errorMessage(error)) || UNCERTAIN.test(whole);
}

function callsTo(run: RunSummary): StreamCall[] {
  return run.calls.filter((candidate) => candidate.tool === run.tool);
}

function outcomeOf(calls: StreamCall[]): { outcome: CellVerdict["outcome"]; error?: string } {
  const last = calls.findLast((candidate) => SETTLED.has(candidate.outcome));
  if (!last) return { outcome: "missing" };
  if (last.outcome === "completed") return { outcome: "success" };
  if (last.outcome === "abandoned") return { outcome: "abandoned" };
  if (isUncertain(last.error)) return { outcome: "uncertain" };
  return { outcome: "error", error: errorMessage(last.error) };
}

// --- baselines ------------------------------------------------------------------------------------------------

const CONFIG_HINT = (tool: string) => ` — set scenarios.${tool}.input in crashtest.config.json`;

/** Why a baseline run is not usable, or null when it is. The call's own error message wins when there is one. */
function baselineProblem(tool: string, run: RunSummary): string | null {
  const last = callsTo(run).at(-1);
  const completed = run.turnOutcome === "completed" && run.preloadReady && last?.outcome === "completed";
  if (completed) return null;
  const message = errorMessage(last?.error);
  if (message !== "") return message;
  if (!run.preloadReady) return "the Crashtest preload did not load";
  if (run.turnOutcome !== "completed") return `the turn ended as ${run.turnOutcome}${run.error ? `: ${run.error}` : ""}`;
  if (!last) return `the model never called ${tool}`;
  return `the call ended as ${last.outcome}`;
}

function describeCounts(counts: Map<string, number>): string {
  if (counts.size === 0) return "no state change";
  return [...counts].map(([endpoint, count]) => `${endpoint} x${count}`).join(", ");
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([endpoint, count]) => b.get(endpoint) === count);
}

/**
 * What two undisturbed runs of `tool` agree on: the state changes per endpoint every later cell is measured
 * against, the body fields that vary on their own, and whether the tool needed approval. Disagreeing or
 * missing facts say why the tool cannot be rated.
 */
export function baselineFacts(tool: string, b1: RunSummary, b2: RunSummary, config: CrashtestConfig): BaselineFacts {
  for (const run of [b1, b2]) {
    const problem = baselineProblem(tool, run);
    if (problem !== null) return { ok: false, reason: "baseline-failed", detail: `${problem}${CONFIG_HINT(tool)}` };
  }
  const first = mutatingEntries(b1, config);
  const second = mutatingEntries(b2, config);
  const counts1 = stateChangeCounts(first);
  const counts2 = stateChangeCounts(second);
  if (!sameCounts(counts1, counts2)) {
    return {
      ok: false,
      reason: "baseline-unstable",
      detail: `baseline 1: ${describeCounts(counts1)}; baseline 2: ${describeCounts(counts2)}`,
    };
  }
  if (counts1.size === 0) {
    return { ok: false, reason: "no-effect", detail: "No external effect observed in the baseline." };
  }
  return {
    ok: true,
    expected: Object.fromEntries(counts1),
    volatileFields: differingKeys(first[0]?.body, second[0]?.body),
    approval: b1.approvals > 0,
  };
}

// --- cells ----------------------------------------------------------------------------------------------------

/** Why a run says nothing about the tool, or null when it can be judged. Checked in this order. */
function invalidReasonOf(cell: Cell, run: RunSummary, calls: StreamCall[]): string | null {
  if (!run.preloadReady) return "preload-missing";
  if (run.turnOutcome !== "completed") return `turn-${run.turnOutcome}`;
  if (cell.point !== "none" && !run.marker) return "crash-not-triggered";
  if (run.killedBy === "harness") return "harness-kill";
  if (run.killedBy === "unexpected") return "unexpected-death";
  if (calls.length === 0) return "no-call";
  return null;
}

function evidenceFor(
  grouped: Map<string, LedgerEntry[]>,
  counts: Map<string, number>,
  expected: Record<string, number>,
  skip: ReadonlySet<string>,
): EffectEvidence[] {
  const endpoints = new Set([...grouped.keys(), ...Object.keys(expected)]);
  const evidence: EffectEvidence[] = [];
  for (const endpoint of endpoints) {
    const count = counts.get(endpoint) ?? 0;
    const wanted = Object.hasOwn(expected, endpoint) ? (expected[endpoint] ?? 0) : 0;
    if (count === 0 && wanted === 0) continue;
    const entries = grouped.get(endpoint) ?? [];
    const diffFields = differingKeys(entries[0]?.body, entries.at(-1)?.body).filter((key) => !skip.has(key));
    evidence.push({ endpoint, count, expected: wanted, diffFields });
  }
  return evidence;
}

/**
 * Judges one run of a cell against the baseline facts. `attempts` is 1: the lane that repeats cells fills in
 * `attempts` and `seen`.
 */
export function analyzeCell(
  cell: Cell,
  run: RunSummary,
  base: { expected: Record<string, number>; volatileFields: string[] },
  config: CrashtestConfig,
): CellVerdict {
  const calls = callsTo(run);
  const recovery: CellVerdict["recovery"] =
    cell.point === "none" ? "none" : calls.some((candidate) => candidate.outcome === "abandoned") ? "interrupted" : "replayed";
  const { outcome, error } = outcomeOf(calls);

  const mutating = mutatingEntries(run, config);
  const counts = stateChangeCounts(mutating);
  const evidence = evidenceFor(groupByEndpoint(mutating), counts, base.expected, new Set([...base.volatileFields, "callId"]));
  const stateChanges = sum(counts.values());
  const expected = sum(Object.values(base.expected));
  const benignRepeats = mutating.filter((entry) => entry.benign).length;
  const assumedKeyHosts = [
    ...new Set(mutating.filter((entry) => entry.benign === KEY_REPLAY).map((entry) => hostOfEndpoint(entry.endpoint))),
  ].filter((host) => !hostInCatalog(host));

  const invalidReason = invalidReasonOf(cell, run, calls);
  let kind: CellVerdict["kind"];
  if (invalidReason !== null) kind = "invalid";
  else if (evidence.some((item) => item.count > item.expected)) kind = "dup";
  else if (stateChanges < expected && outcome === "success") kind = "lost-effect";
  else if (stateChanges >= expected && outcome === "error") kind = "phantom-failure";
  else kind = "clean";

  return {
    cellId: cell.id,
    kind,
    ...(kind === "dup" ? { dupClass: recovery === "interrupted" ? ("retry" as const) : cell.idMode } : {}),
    recovery,
    outcome,
    stateChanges,
    expected,
    benignRepeats,
    attempts: 1,
    ...(invalidReason !== null ? { invalidReason } : {}),
    ...(error !== undefined ? { error } : {}),
    evidence,
    ...(assumedKeyHosts.length > 0 ? { assumedKeyHosts } : {}),
  };
}
