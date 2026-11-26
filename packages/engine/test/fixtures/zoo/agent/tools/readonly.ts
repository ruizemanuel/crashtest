// Rating case: a read-only tool. It changes nothing, so a replay cannot hurt.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up an order.",
  inputSchema: z.object({
    orderId: z.string().describe("Order to look up."),
  }),
  async execute({ orderId }, ctx) {
    const url = new URL(`https://api.acme-orders.test/v1/orders/${encodeURIComponent(orderId)}`);
    url.searchParams.set("callId", ctx.callId);
    url.searchParams.set("turnId", ctx.session.turn.id);
    const response = await fetch(url);
    return (await response.json()) as Record<string, unknown>;
  },
});
