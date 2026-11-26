// Rating case: an idempotency key the provider honors, built from business identity fields, so every repeat is deduplicated upstream.
import { createHash } from "node:crypto";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund part or all of a charge.",
  inputSchema: z.object({
    chargeId: z.string().describe("Charge to refund."),
    amount: z.number().int().min(100).describe("Amount to refund, in cents."),
    reason: z.enum(["requested_by_customer", "duplicate"]).describe("Why the charge is refunded."),
  }),
  async execute({ chargeId, amount, reason }, ctx) {
    const key = createHash("sha256").update([ctx.session.id, ctx.session.turn.id, ctx.toolName, chargeId, String(amount)].join("|")).digest("hex");
    const response = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "idempotency-key": key },
      body: new URLSearchParams({ charge: chargeId, amount: String(amount), reason }).toString(),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
