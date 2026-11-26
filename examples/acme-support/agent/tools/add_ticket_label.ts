// Idempotent by nature: a repeat adds a label the ticket already has and changes nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Add a label to a customer's support ticket.",
  inputSchema: z.object({
    issueNumber: z.number().int().min(1).describe("Support ticket (GitHub issue) to label."),
    label: z.enum(["refund", "vip"]).describe("Label to add."),
  }),
  async execute({ issueNumber, label }) {
    const response = await fetch(`https://api.github.com/repos/acme/support/issues/${issueNumber}/labels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${process.env.GITHUB_KEY ?? ""}`,
      },
      body: JSON.stringify({ labels: [label] }),
    });
    return { labels: (await response.json()) as unknown[] };
  },
});
