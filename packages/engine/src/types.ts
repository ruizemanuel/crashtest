export type CrashPoint = "none" | "post-effect-fast" | "post-effect-slow" | "post-settle";
export type IdMode = "stable" | "fresh";
export type CellId = "baseline-1" | "baseline-2" | "post-effect-fast-stable" | "post-effect-fast-fresh" | "post-effect-slow" | "post-settle";
export type JsonSchema = Record<string, unknown>;
export interface Cell { id: CellId; point: CrashPoint; idMode: IdMode; latencyMs: number; holdMs: number }
export interface ToolInfo { name: string; file: string /* lab-relative, posix */; inputSchema: JsonSchema | null }
export interface LedgerEntry {
  seq: number; ts: string; pid: number; kind: "http" | "fs";
  method: string;            // HTTP method, or "WRITE" | "APPEND"
  url: string;               // full URL, or lab-relative posix path
  endpoint: string;          // "POST api.stripe.com/v1/refunds", "APPEND data/outbox.jsonl"
  mutating: boolean; stateChange: boolean; benign?: string;
  idempotencyKey?: string; body: unknown; status: number;
}
export interface StreamCall { callId: string; tool: string; outcome: string /* requested|completed|failed|abandoned|... */; output?: unknown; error?: unknown }
export interface RunSummary {
  tool: string; cellId: CellId; attempt: number; crashPoint: CrashPoint; idMode: IdMode; latencyMs: number; holdMs: number;
  eveVersion: string; port: number; sessionId: string | null; preloadReady: boolean; marker: string | null;
  serverDied: boolean; killedBy: "crash-point" | "harness" | "unexpected" | null; restarted: boolean;
  turnOutcome: string;       // completed|failed|cancelled|timeout|startup-failed|died-after-resume|stream-failed
  approvals: number; calls: StreamCall[]; ledger: LedgerEntry[]; wallMs: number; runDir: string; error?: string;
}
export type VerdictKind = "clean" | "dup" | "phantom-failure" | "lost-effect" | "invalid";
export interface EffectEvidence { endpoint: string; count: number; expected: number; diffFields: string[] }
export interface CellVerdict {
  cellId: CellId; kind: VerdictKind; dupClass?: "stable" | "fresh" | "retry";
  recovery: "none" | "replayed" | "interrupted"; outcome: "success" | "uncertain" | "error" | "abandoned" | "missing";
  stateChanges: number; expected: number; benignRepeats: number; attempts: number; seen?: string /* "2 of 3" */;
  invalidReason?: string; error?: string; evidence: EffectEvidence[];
}
export type NaReason = "no-effect" | "baseline-failed" | "baseline-unstable" | "cells-invalid" | "not-discovered";
export type Stars = 1 | 2 | 3 | 4 | 5;
export interface ToolRating {
  tool: string; stars: Stars | null; na?: { reason: NaReason; detail: string }; approval: boolean;
  waived?: string; benignRepeats: boolean; identity: string[]; summary: string; recommendation: string; cells: CellVerdict[];
}
export interface LaneResult { tool: string; rating: ToolRating; runs: number; wallMs: number }
export interface EveFacts { version: string; capabilities: { replayNever: boolean } }
export interface Report {
  schemaVersion: 1; engine: { name: "eve-crashtest"; version: string }; createdAt: string;
  target: { name: string; commit: string | null; dirty: boolean }; eve: EveFacts;
  lab: { platform: string; node: string; cells: number };
  agent: { stars: Stars | null; evaluated: number; total: number }; tools: ToolRating[];
}
