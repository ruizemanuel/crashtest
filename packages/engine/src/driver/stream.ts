import type { StreamCall } from "../types.ts";

export interface ParsedStream {
  calls: StreamCall[];
  /** Ids of interactions opened and not settled afterwards (e.g. a pending approval). */
  openInteractions: string[];
  turnOutcome: string | null;
}

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Digest an eve session stream (NDJSON; each line an object with a `facts` array) into the
 * tool calls it recorded, the interactions still waiting for an answer and the last turn outcome.
 * Lines that are not JSON, or carry no facts, are skipped.
 */
export function parseStream(ndjson: string): ParsedStream {
  const calls = new Map<string, StreamCall>();
  const open = new Set<string>();
  let turnOutcome: string | null = null;

  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const facts = asObject(parsed)?.facts;
    if (!Array.isArray(facts)) continue;

    for (const fact of facts) {
      const f = asObject(fact);
      const data = asObject(f?.data);
      if (!f || !data) continue;
      const callId = str(data.callId);
      const interactionId = str(data.interactionId);
      switch (f.type) {
        case "call.requested":
          if (callId) calls.set(callId, { callId, tool: str(asObject(data.capability)?.name) ?? "?", outcome: "requested" });
          break;
        case "call.settled": {
          if (!callId) break;
          const call = calls.get(callId) ?? { callId, tool: "?", outcome: "settled" };
          call.outcome = str(data.outcome) ?? "settled";
          if (data.error) call.error = data.error;
          if (data.output !== undefined) call.output = data.output;
          calls.set(callId, call);
          break;
        }
        case "interaction.opened":
          if (interactionId) open.add(interactionId);
          break;
        case "interaction.settled":
          if (interactionId) open.delete(interactionId);
          break;
        case "turn.settled":
          turnOutcome = str(data.outcome) ?? "unknown";
          break;
      }
    }
  }
  return { calls: [...calls.values()], openInteractions: [...open], turnOutcome };
}
