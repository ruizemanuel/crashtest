// Rating case: an operation record keyed on session, turn, tool and identity fields. A repeat gets the stored result or an uncertain outcome.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";

/** Where the operation records live, relative to the working directory of `eve dev`. */
const STORE_DIR = ".crashtest-idempotency";
const OUTCOME_UNKNOWN = "OUTCOME_UNKNOWN: a previous attempt may have sent this message; check before retrying";

type OperationRecord = { status: "started" } | { status: "done"; result: Record<string, unknown> };

function errorCode(error: unknown): unknown {
  return (error as NodeJS.ErrnoException).code;
}

function readRecord(file: string): OperationRecord | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OperationRecord;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

export default defineTool({
  description: "Send an order notification to a customer, at most once per order and turn.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
    text: z.string().describe("Message text."),
  }),
  async execute({ to, orderId, text }, ctx) {
    const key = createHash("sha256").update([ctx.session.id, ctx.session.turn.id, ctx.toolName, to, orderId].join("|")).digest("hex");
    mkdirSync(STORE_DIR, { recursive: true });
    const file = join(STORE_DIR, `${key}.json`);

    const record = readRecord(file);
    if (record?.status === "done") return record.result;
    if (record?.status === "started") throw new Error(OUTCOME_UNKNOWN);
    try {
      writeFileSync(file, JSON.stringify({ status: "started" } satisfies OperationRecord), { flag: "wx" });
    } catch (error) {
      // Another attempt claimed the operation between the read and the write.
      if (errorCode(error) === "EEXIST") throw new Error(OUTCOME_UNKNOWN);
      throw error;
    }

    const response = await fetch("https://api.acme-notify.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, orderId, text, callId: ctx.callId, turnId: ctx.session.turn.id }),
    });
    const result = (await response.json()) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ status: "done", result } satisfies OperationRecord));
    return result;
  },
});
