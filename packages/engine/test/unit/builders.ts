// Small builders for run summaries, ledger entries, stream calls and cell verdicts, so each test states
// only the fields it cares about.
import type { CellVerdict, LedgerEntry, RunSummary, StreamCall } from "../../src/types.ts";

export const REFUNDS = "POST api.stripe.com/v1/refunds";
export const REFUNDS_URL = "https://api.stripe.com/v1/refunds";

let nextSeq = 1;

/** A mutating, state-changing POST to the Stripe refunds endpoint unless `partial` says otherwise. */
export function entry(partial: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq: nextSeq++,
    ts: "2026-01-01T00:00:00.000Z",
    pid: 1,
    kind: "http",
    method: "POST",
    url: REFUNDS_URL,
    endpoint: REFUNDS,
    mutating: true,
    stateChange: true,
    body: {},
    status: 200,
    ...partial,
  };
}

/** The faked, non-mutating discovery request eve makes in every run. */
export function catalogEntry(): LedgerEntry {
  return entry({
    method: "GET",
    url: "https://ai-gateway.vercel.sh/v1/models/catalog",
    endpoint: "GET ai-gateway.vercel.sh/v1/models/catalog",
    mutating: false,
    stateChange: false,
  });
}

/** A completed call to `naive` unless `partial` says otherwise. */
export function call(partial: Partial<StreamCall> = {}): StreamCall {
  return { callId: "call_1", tool: "naive", outcome: "completed", ...partial };
}

/** A completed baseline-style run of `naive` with an empty ledger and one completed call. */
export function summary(partial: Partial<RunSummary> = {}): RunSummary {
  const tool = partial.tool ?? "naive";
  return {
    tool,
    cellId: "baseline-1",
    attempt: 1,
    crashPoint: "none",
    idMode: "stable",
    latencyMs: 0,
    holdMs: 0,
    eveVersion: "1.5.0",
    port: 4100,
    sessionId: "wrun_test",
    preloadReady: true,
    marker: null,
    serverDied: false,
    killedBy: null,
    restarted: false,
    turnOutcome: "completed",
    approvals: 0,
    calls: [call({ tool })],
    ledger: [],
    wallMs: 1000,
    runDir: "runs/test",
    ...partial,
  };
}

/** A clean one-effect verdict for `cellId` unless `partial` says otherwise. */
export function verdict(partial: Partial<CellVerdict> = {}): CellVerdict {
  return {
    cellId: "post-effect-fast-stable",
    kind: "clean",
    recovery: "replayed",
    outcome: "success",
    stateChanges: 1,
    expected: 1,
    benignRepeats: 0,
    attempts: 1,
    evidence: [{ endpoint: REFUNDS, count: 1, expected: 1, diffFields: [] }],
    ...partial,
  };
}
