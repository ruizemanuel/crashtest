// Rating case: a file-system effect with no protection. A replay appends the outbox line twice.
import { appendFileSync, mkdirSync } from "node:fs";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Queue an order notification for a customer in the outbox file.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
  }),
  async execute({ to, orderId }) {
    // Creating the directory is not an effect: crashtest does not observe mkdir, and an empty directory changes nothing.
    mkdirSync("data", { recursive: true });
    appendFileSync("data/outbox.jsonl", `${JSON.stringify({ to, orderId })}\n`);
    return { queued: true, to, orderId };
  },
});
