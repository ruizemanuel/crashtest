// SPIKE: the "user's" original tool, untouched by the crash harness.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import { z } from "zod";

const SPIKE_DIR = process.env.SPIKE_DIR ?? join(process.cwd(), ".spike");

export default defineTool({
  description: "Send a message to a person.",
  inputSchema: z.object({ to: z.string(), text: z.string() }),
  async execute({ to, text }, ctx) {
    mkdirSync(SPIKE_DIR, { recursive: true });
    const outbox = join(SPIKE_DIR, "outbox.jsonl");
    if (process.env.SPIKE_FIX === "1" && existsSync(outbox)) {
      const already = readFileSync(outbox, "utf8").split("\n").filter(Boolean)
        .some((l) => JSON.parse(l).callId === ctx.callId);
      if (already) return { sent: true, deduped: true };
    }
    appendFileSync(
      outbox,
      `${JSON.stringify({ at: new Date().toISOString(), callId: ctx.callId, to, text, pid: process.pid })}\n`,
    );
    return { sent: true };
  },
});
