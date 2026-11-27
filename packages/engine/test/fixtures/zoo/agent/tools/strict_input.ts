// Rating case: an input schema the generated input does not satisfy, so the AI SDK rejects the call before the tool runs.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Escalate a support ticket.",
  inputSchema: z.object({
    ticketId: z.string().regex(/^TCK-\d+$/).describe("Ticket to escalate."),
  }),
  async execute({ ticketId }) {
    const response = await fetch("https://api.acme-tickets.test/v1/escalations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticketId }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
