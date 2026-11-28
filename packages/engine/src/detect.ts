// Turns run summaries into facts: what a clean run looks like (baselineFacts) and what a crashed run did
// compared with it (analyzeCell). Pure: no I/O, no clock.
import type { CrashtestConfig } from "./config.ts";
import { hostInCatalog } from "./preload/catalog.ts";
import { ignoreMatcher } from "./preload/effects-ignore.ts";
import { KEY_REPLAY } from "./preload/fake-provider.ts";
import { REDACTED } from "./preload/normalize.ts";
import type { Cell, CellVerdict, EffectEvidence, LedgerEntry, NaReason, RunSummary, StreamCall } from "./types.ts";

export type BaselineFacts =
  | {
      ok: true;
      expected: Record<string, number>;
      /** The sorted union of `volatileByEndpoint`, for the evidence display. */
      volatileFields: string[];
      /** Per endpoint, the body fields that differ between the two baselines. */
      volatileByEndpoint: Record<string, string[]>;
      approval: boolean;
    }
  | { ok: false; reason: NaReason; detail: string };

/** The benign label of a repeated write to one object whose body differs only in fields that vary between the baselines. */
export const MASKED_REPEAT = "same object written again; only fields that vary between the baselines differ";

/**
 * What `maskedFields` records for a masked repeat whose bodies differ in no key but hold a redacted value: the ledger
 * redacts secrets, so the difference the provider saw can only sit in a redacted field.
 */
export const REDACTED_FIELD = "a redacted field";

/**
 * The marker the lab's responder appends to a free-text field when the fresh-id and retry cells reword it
 * (`templates/responder.ts`, `perturb`). A `g` regex: use it only with `replace`, which does not keep its state.
 */
export const REWORDING = / \(rewritten \d+\)/g;

/**
 * The benign label of a repeated write to one object whose body differs from the earlier write only in text the lab
 * reworded for the replay, and possibly in fields that vary between the baselines.
 */
export const REWORDED_REPEAT = "same object written again with text the lab reworded for the replay";

/** What `rewordedFields` records when the reworded body is not a JSON object, such as a text or Markdown body. */
export const REWORDED_TEXT = "the body text";

/**
 * A copy of `value` with the lab's rewording marker (`REWORDING`) removed from every string, at any depth of arrays
 * and objects: inside JSON held in a string too, since the marker is plain text there. Keys stay as they are.
 */
export function withoutRewording(value: unknown): unknown {
  if (typeof value === "string") return value.replace(REWORDING, "");
  if (Array.isArray(value)) return value.map(withoutRewording);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutRewording(inner)]));
  return value;
}

/** The methods whose repeat to one object overwrites it rather than adding to it. */
const OVERWRITES = new Set(["PUT", "DELETE"]);

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
export function mutatingEntries(run: RunSummary, config: CrashtestConfig): LedgerEntry[] {
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

/** The distinct values, sorted. */
function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * The entries grouped by the object they write, within their endpoint: one group per object the fake provider
 * names, and one for the endpoint's entries that name none.
 */
function groupByObject(entries: LedgerEntry[]): Map<string, LedgerEntry[]> {
  const groups = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.endpoint, entry.object ?? null]);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return groups;
}

/**
 * The body fields that vary on their own, per endpoint: the sorted top-level keys that differ between the n-th
 * entry to an object in one baseline and the n-th to that object in the other (entries that name no object are
 * paired per endpoint). Pairing per object keeps two objects on one endpoint, such as two Vercel Blob puts that reach
 * the provider in another order, from being compared with each other. Endpoints where no key differs are left out.
 */
export function volatileFieldsOf(first: LedgerEntry[], second: LedgerEntry[]): Record<string, string[]> {
  const others = groupByObject(second);
  const volatile = new Map<string, string[]>();
  for (const [key, entries] of groupByObject(first)) {
    const partners = others.get(key) ?? [];
    entries.forEach((entry, index) => {
      const partner = partners[index];
      const keys = partner === undefined ? [] : differingKeys(entry.body, partner.body);
      if (keys.length > 0) volatile.set(entry.endpoint, [...(volatile.get(entry.endpoint) ?? []), ...keys]);
    });
  }
  return Object.fromEntries([...volatile].map(([endpoint, keys]) => [endpoint, sortedUnique(keys)]));
}

/** A body without the `skip` keys; a body that is not an object stays whole. */
function withoutKeys(body: unknown, skip: readonly string[]): unknown {
  if (!isRecord(body)) return body;
  return Object.fromEntries(Object.entries(body).filter(([key]) => !skip.includes(key)));
}

/** Whether a ledger body holds a redacted value at any depth. */
function holdsRedacted(body: unknown): boolean {
  if (body === REDACTED) return true;
  if (Array.isArray(body)) return body.some(holdsRedacted);
  return isRecord(body) && Object.values(body).some(holdsRedacted);
}

/**
 * Whether the object holds the body of this write afterwards: the write changed state, or it was a benign repeat of
 * a body the object already held. A write the provider refused (a conditional PUT answered 412) stored nothing.
 */
function applied(entry: LedgerEntry): boolean {
  return entry.stateChange || entry.benign !== undefined;
}

/**
 * The entries with every repeated write to one object that changed only fields varying between the baselines
 * turned into a benign repeat (`MASKED_REPEAT`): an HTTP PUT or DELETE that changed state, after an earlier applied
 * entry to the same object whose body is the same once the endpoint's `volatile` keys are left out of both. Only a
 * write whose object the fake provider names (`object`) can be masked: a write it does not name, such as one a
 * fixture answered, gives no ground to assume an overwrite and stays a state change. The order is kept and the input
 * is not mutated. `maskedFields` lists the volatile keys whose values did differ in those pairs, and
 * `REDACTED_FIELD` for a pair whose bodies differ in no key but hold a redacted value.
 *
 * A pair whose bodies are the same only once the lab's rewording is also stripped (`withoutRewording`) is a benign
 * repeat too, labeled `REWORDED_REPEAT`: the fresh-id and retry cells reworded the call's free text, and the service
 * overwrites the object with it. `rewordedFields` lists the other keys whose values differed in those pairs, or
 * `REWORDED_TEXT` for a body that is not an object.
 */
export function maskRepeats(
  entries: LedgerEntry[],
  volatile: Record<string, string[]>,
): { entries: LedgerEntry[]; maskedFields: string[]; rewordedFields: string[] } {
  const maskedFields: string[] = [];
  const rewordedFields: string[] = [];
  const masked = entries.map((entry, index) => {
    const { object } = entry;
    if (object === undefined || entry.kind !== "http" || !entry.stateChange || !OVERWRITES.has(entry.method)) return entry;
    const skip = Object.hasOwn(volatile, entry.endpoint) ? (volatile[entry.endpoint] ?? []) : [];
    const unreworded = (body: unknown): string => canonical(withoutRewording(withoutKeys(body, skip)));
    const body = unreworded(entry.body);
    const earlier = entries
      .slice(0, index)
      .findLast((candidate) => applied(candidate) && candidate.object === object && unreworded(candidate.body) === body);
    if (earlier === undefined) return entry;
    const differing = differingKeys(earlier.body, entry.body);
    if (canonical(withoutKeys(earlier.body, skip)) === canonical(withoutKeys(entry.body, skip))) {
      const hidden = differing.length === 0 && (holdsRedacted(earlier.body) || holdsRedacted(entry.body));
      maskedFields.push(...(hidden ? [REDACTED_FIELD] : differing));
      return { ...entry, stateChange: false, benign: MASKED_REPEAT };
    }
    maskedFields.push(...differing.filter((key) => skip.includes(key)));
    const objects = isRecord(earlier.body) && isRecord(entry.body);
    rewordedFields.push(...(objects ? differing.filter((key) => !skip.includes(key)) : [REWORDED_TEXT]));
    return { ...entry, stateChange: false, benign: REWORDED_REPEAT };
  });
  return { entries: masked, maskedFields: sortedUnique(maskedFields), rewordedFields: sortedUnique(rewordedFields) };
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

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The output's `error` when it has words: a non-empty string, or the non-empty `message` of an object. */
function errorText(error: unknown): string | null {
  return nonEmptyText(error) ?? (isRecord(error) ? nonEmptyText(error.message) : null);
}

/**
 * The refusal text of a call that returned its failure as a value instead of throwing, as real templates do
 * (`{ success: false, error }`), or null when the output does not read as a refusal. An output with `success` or
 * `ok` false is a refusal; its text is the first one among `error`, `error.message`, `message` and `reason`, else the
 * output itself, cut to 200 characters. Without either flag set to true, an `error` with words is a refusal too.
 */
export function refusalOf(output: unknown): string | null {
  if (!isRecord(output)) return null;
  if (output.success === false || output.ok === false) {
    return errorText(output.error) ?? nonEmptyText(output.message) ?? nonEmptyText(output.reason) ?? (JSON.stringify(output) ?? "").slice(0, 200);
  }
  if (output.success === true || output.ok === true) return null;
  return errorText(output.error);
}

function callsTo(run: RunSummary): StreamCall[] {
  return run.calls.filter((candidate) => candidate.tool === run.tool);
}

/**
 * A completed call whose output is a refusal counts as the error the model got, or as an uncertain outcome when an
 * uncertain-outcome code (`UNCERTAIN`) appears anywhere in the output, as the whole error of a thrown call is read.
 */
function outcomeOf(calls: StreamCall[]): { outcome: CellVerdict["outcome"]; error?: string } {
  const last = calls.findLast((candidate) => SETTLED.has(candidate.outcome));
  if (!last) return { outcome: "missing" };
  if (last.outcome === "completed") {
    const refusal = refusalOf(last.output);
    if (refusal === null) return { outcome: "success" };
    const uncertain = UNCERTAIN.test(refusal) || UNCERTAIN.test(JSON.stringify(last.output) ?? "");
    return uncertain ? { outcome: "uncertain" } : { outcome: "error", error: refusal };
  }
  if (last.outcome === "abandoned") return { outcome: "abandoned" };
  if (isUncertain(last.error)) return { outcome: "uncertain" };
  return { outcome: "error", error: errorMessage(last.error) };
}

// --- baselines ------------------------------------------------------------------------------------------------

/** A failure that reads as the tool refusing the lab session's caller (real tools check the channel identity). */
const AUTH_PROBLEM = /unauthori[sz]ed|authori[sz]ation|authenticat|forbidden|permission denied|not allowed|sign in|\bsession\b|\bcontext\b|\b40[13]\b/i;
/** A failure that reads as the tool rejecting its input. */
const INPUT_PROBLEM = /invalid|expected|required|validation|must be|schema/i;

/** Why a baseline run is not usable: the tool call's own error message, or a problem the engine words itself. */
interface BaselineProblem {
  text: string;
  toolError: boolean;
  /** The AI SDK rejected the call's input before the tool ran. */
  rejectedInput?: true;
  /** The call completed and returned its failure as a value; `text` is the refusal's own text. */
  refusal?: true;
}

/**
 * What to append to a baseline problem: the configuration key that most likely fixes it. A rejected input always
 * points at the input: the rejection quotes the input, whose values may name a session or a context. Otherwise only
 * the tool's own error is read for words; the engine's own text (a server that did not start, a session create that
 * failed, a log tail) names sessions and contexts of its own, so it always gets the general hint.
 */
function baselineHint(tool: string, problem: BaselineProblem): string {
  if (problem.rejectedInput) return ` — set scenarios.${tool}.input in crashtest.config.json`;
  if (problem.toolError && AUTH_PROBLEM.test(problem.text)) {
    return ` — set auth or scenarios.${tool}.auth in crashtest.config.json to give the lab session the identity this tool checks`;
  }
  if (problem.toolError && INPUT_PROBLEM.test(problem.text)) return ` — set scenarios.${tool}.input in crashtest.config.json`;
  return ` — see the run directory; crashtest.config.json can set scenarios.${tool}.input, auth, env and fixtures`;
}

/**
 * Why a baseline run is not usable, or null when it is. A call whose input the AI SDK rejected never reaches eve's
 * stream, so without a call the error result the model saw (`firstToolError`) says why. A completed call that
 * returned a refusal failed as much as one that threw, whatever it changed before: an error that the run without a
 * crash returns too says nothing about recovery. Otherwise the call's own error message wins when there is one.
 */
function baselineProblem(tool: string, run: RunSummary): BaselineProblem | null {
  const last = callsTo(run).at(-1);
  if (run.preloadReady && last === undefined && run.firstToolError !== undefined) {
    return { text: `the call was rejected before ${tool} ran: ${run.firstToolError}`, toolError: true, rejectedInput: true };
  }
  const completed = run.turnOutcome === "completed" && run.preloadReady && last?.outcome === "completed";
  if (completed) {
    const refusal = refusalOf(last.output);
    return refusal === null ? null : { text: refusal, toolError: true, refusal: true };
  }
  const message = errorMessage(last?.error);
  if (message !== "") return { text: message, toolError: true };
  return { text: engineProblem(tool, run, last), toolError: false };
}

/** A baseline problem as the reason words it: a refusal says that the call returned it. */
function describeProblem(problem: BaselineProblem): string {
  return problem.refusal ? `the call returned a refusal: ${problem.text}` : problem.text;
}

/** A failed baseline without an error message from the tool, as the engine words it. */
function engineProblem(tool: string, run: RunSummary, last: StreamCall | undefined): string {
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
 * missing facts say why the tool cannot be rated. The state changes are counted after `maskRepeats`, as in a cell,
 * so a tool that rewrites its own object within one turn is measured the same way in both.
 */
export function baselineFacts(tool: string, b1: RunSummary, b2: RunSummary, config: CrashtestConfig): BaselineFacts {
  for (const run of [b1, b2]) {
    const problem = baselineProblem(tool, run);
    if (problem !== null) return { ok: false, reason: "baseline-failed", detail: `${describeProblem(problem)}${baselineHint(tool, problem)}` };
  }
  const first = mutatingEntries(b1, config);
  const second = mutatingEntries(b2, config);
  const volatileByEndpoint = volatileFieldsOf(first, second);
  const counts1 = stateChangeCounts(maskRepeats(first, volatileByEndpoint).entries);
  const counts2 = stateChangeCounts(maskRepeats(second, volatileByEndpoint).entries);
  if (!sameCounts(counts1, counts2)) {
    return {
      ok: false,
      reason: "baseline-unstable",
      detail: `baseline 1: ${describeCounts(counts1)}; baseline 2: ${describeCounts(counts2)}`,
    };
  }
  if (counts1.size === 0) return { ok: false, reason: "no-effect", detail: "No external effect observed in the baseline." };
  return {
    ok: true,
    expected: Object.fromEntries(counts1),
    volatileFields: sortedUnique(Object.values(volatileByEndpoint).flat()),
    volatileByEndpoint,
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
 * `attempts` and `seen`. The ledger is read after `maskRepeats`: a repeated write that changed only fields varying
 * between the baselines is a benign repeat, not a state change.
 */
export function analyzeCell(
  cell: Cell,
  run: RunSummary,
  base: { expected: Record<string, number>; volatileFields: string[]; volatileByEndpoint: Record<string, string[]> },
  config: CrashtestConfig,
): CellVerdict {
  const calls = callsTo(run);
  const recovery: CellVerdict["recovery"] =
    cell.point === "none" ? "none" : calls.some((candidate) => candidate.outcome === "abandoned") ? "interrupted" : "replayed";
  const { outcome, error } = outcomeOf(calls);

  const { entries: mutating, maskedFields, rewordedFields } = maskRepeats(mutatingEntries(run, config), base.volatileByEndpoint);
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
    ...(maskedFields.length > 0 ? { maskedFields } : {}),
    ...(rewordedFields.length > 0 ? { rewordedFields } : {}),
  };
}
