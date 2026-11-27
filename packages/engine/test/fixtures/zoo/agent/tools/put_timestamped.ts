// Rating case: a PUT that overwrites one object and stamps the time; a replay writes the same object again.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Save the display name on a customer profile.",
  inputSchema: z.object({
    customerId: z.string().describe("Customer whose profile is saved."),
    displayName: z.string().describe("Name shown on the profile."),
  }),
  async execute({ customerId, displayName }) {
    const response = await fetch(`https://api.acme-store.test/v1/profiles/${encodeURIComponent(customerId)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId, displayName, updatedAt: new Date().toISOString() }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
