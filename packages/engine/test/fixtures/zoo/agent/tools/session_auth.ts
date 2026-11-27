// Rating case: a tool that checks the channel identity of the session, as real templates do. Without that identity
// its baseline fails; with the one crashtest.config.json gives the lab session, it is as unprotected as naive.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an order notification to a customer of the zoo team.",
  inputSchema: z.object({
    to: z.string().describe("Customer to notify."),
    orderId: z.string().describe("Order the message is about."),
    text: z.string().describe("Message text."),
  }),
  async execute({ to, orderId, text }, ctx) {
    const caller = ctx.session.auth.current;
    if (caller?.authenticator !== "crashtest-zoo" || caller.attributes.team_id !== "T0ZOO") {
      throw new Error("Authorization denied: not in a zoo session");
    }
    const response = await fetch("https://api.acme-notify.test/v1/session-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, orderId, text, callId: ctx.callId, turnId: ctx.session.turn.id }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
