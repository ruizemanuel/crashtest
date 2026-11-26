// Rating case: a side effect with no idempotency protection. A replay sends the message twice.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an order notification to a customer.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
    text: z.string().describe("Message text."),
  }),
  async execute({ to, orderId, text }, ctx) {
    const response = await fetch("https://api.acme-notify.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, orderId, text, callId: ctx.callId, turnId: ctx.session.turn.id }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
