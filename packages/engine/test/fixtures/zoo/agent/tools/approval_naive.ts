// Rating case: the same unprotected side effect behind an approval gate on every call.
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Send an order notification to a customer once a person approved it.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
    text: z.string().describe("Message text."),
  }),
  approval: always(),
  async execute({ to, orderId, text }, ctx) {
    const response = await fetch("https://api.acme-notify.test/v1/approved-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, orderId, text, callId: ctx.callId, turnId: ctx.session.turn.id }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
