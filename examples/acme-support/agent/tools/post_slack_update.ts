// Unprotected behind an approval gate: a person approves the post once, and a step that eve replays after the approved call posts it twice.
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

export default defineTool({
  description: "Post an order update to the team's Slack channel once a person approved it.",
  inputSchema: z.object({
    channel: z.string().describe("Slack channel to post in."),
    orderId: z.string().describe("Order the update is about."),
    text: z.string().describe("Update to post."),
  }),
  approval: always(),
  async execute({ channel, orderId, text }) {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.SLACK_KEY ?? ""}`,
      },
      body: JSON.stringify({ channel, text: `Order ${orderId}: ${text}` }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
