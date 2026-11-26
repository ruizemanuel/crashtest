// Rating case: a set-add that is idempotent by nature. A repeat adds a label the issue already has and changes nothing.
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Add a label to a support issue.",
  inputSchema: z.object({
    issueNumber: z.number().int().min(1).describe("Issue to label."),
    label: z.enum(["bug", "triage"]).describe("Label to add."),
  }),
  async execute({ issueNumber, label }) {
    const response = await fetch(`https://api.github.com/repos/acme/support/issues/${issueNumber}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/vnd.github+json" },
      body: JSON.stringify({ labels: [label] }),
    });
    return { labels: (await response.json()) as unknown[] };
  },
});
