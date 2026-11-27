// Rating case: a tool that only reads, through requests sent as POST (a Vercel Connect token exchange, then a Slack
// read method). Neither is an effect, so there is nothing to rate.
import { defineTool } from "eve/tools";
import { z } from "zod";

interface History {
  messages?: unknown[];
}

export default defineTool({
  description: "Count the messages of a team channel.",
  inputSchema: z.object({
    channel: z.string().describe("Channel to read."),
  }),
  async execute({ channel }) {
    await fetch("https://api.vercel.com/v1/connect/token/slack%2Fzoo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const response = await fetch("https://slack.com/api/conversations.history", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ channel }).toString(),
    });
    const history = (await response.json()) as History;
    return { messages: (history.messages ?? []).length };
  },
});
