// Keyed on `ctx.callId`: a replay with the same call id is deduplicated, but a call the model issues again gets a new id and sends a second email.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Email a customer about their order.",
  inputSchema: z.object({
    to: z.email().describe("Customer's email address."),
    orderId: z.string().describe("Order the email is about."),
    subject: z.string().describe("Subject line."),
    body: z.string().describe("Body of the email, as HTML."),
  }),
  async execute({ to, orderId, subject, body }, ctx) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_KEY ?? ""}`,
        "Idempotency-Key": ctx.callId,
      },
      body: JSON.stringify({ from: "support@acme.test", to, subject, html: body, tags: [{ name: "order", value: orderId }] }),
    });
    if (!response.ok) throw new Error(`Email failed with status ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  },
});
