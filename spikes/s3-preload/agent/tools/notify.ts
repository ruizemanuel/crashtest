// SPIKE (S3): an ordinary "user" tool with an external HTTP side effect. No crash code here.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send a notification message to a person.",
  inputSchema: z.object({ to: z.string(), text: z.string() }),
  async execute({ to, text }, ctx) {
    const res = await fetch("https://api.provider.test/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, text, callId: ctx.callId }),
    });
    return (await res.json()) as { ok: boolean; id: string };
  },
});
