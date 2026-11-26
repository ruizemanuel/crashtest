// "User" tool with a relative import and a package-imports alias.
import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatMessage } from "../lib/format";
import { ENDPOINT } from "#lib/endpoint.ts";

export default defineTool({
  description: "Send a notification message to a person.",
  inputSchema: z.object({ to: z.string(), text: z.string() }),
  async execute({ to, text }, ctx) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, text: formatMessage(to, text), callId: ctx.callId }),
    });
    return (await res.json()) as { ok: boolean; id: string };
  },
});
