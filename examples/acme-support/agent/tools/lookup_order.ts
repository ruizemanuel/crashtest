// Read-only: it changes nothing, so a replay cannot hurt and crashtest has no effect to rate.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Look up an order.",
  inputSchema: z.object({
    orderId: z.string().describe("Order to look up."),
  }),
  async execute({ orderId }) {
    const response = await fetch(`https://api.acme.test/v1/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${process.env.ACME_KEY ?? ""}` },
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
