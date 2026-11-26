// Unprotected on purpose: the refund carries no idempotency key, so a step that eve replays after a crash refunds twice.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Refund part or all of a customer's charge.",
  inputSchema: z.object({
    chargeId: z.string().describe("Charge to refund."),
    amount: z.number().int().min(100).describe("Amount to refund, in cents."),
    reason: z.enum(["requested_by_customer", "duplicate", "fraudulent"]).describe("Why the charge is refunded."),
  }),
  async execute({ chargeId, amount, reason }) {
    const response = await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.STRIPE_KEY ?? ""}`,
      },
      body: new URLSearchParams({ charge: chargeId, amount: String(amount), reason }).toString(),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
