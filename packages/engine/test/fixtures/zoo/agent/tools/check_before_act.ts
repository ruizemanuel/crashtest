// Rating case: no idempotency key, but the tool looks the message up first and does not post an order's message twice.
import { defineTool } from "eve/tools";
import { z } from "zod";

interface History {
  messages?: { text?: unknown }[];
}

export default defineTool({
  description: "Post an order update to a team channel.",
  inputSchema: z.object({
    channel: z.string().describe("Channel to post in."),
    orderId: z.string().describe("Order the update is about."),
    text: z.string().describe("Message text."),
  }),
  async execute({ channel, orderId, text }) {
    const marker = `[order:${orderId}]`;
    const historyUrl = new URL("https://slack.com/api/conversations.history");
    historyUrl.searchParams.set("channel", channel);
    const history = (await (await fetch(historyUrl)).json()) as History;
    const posted = (history.messages ?? []).some((message) => typeof message.text === "string" && message.text.includes(marker));
    if (posted) return { ok: true, deduped: true };

    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, text: `${text} ${marker}` }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
