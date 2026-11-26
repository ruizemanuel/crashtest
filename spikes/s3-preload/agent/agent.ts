// SPIKE (S3): deterministic agent calling one HTTP side-effecting tool.
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel({
    modelId: "s3-script",
    provider: "spike",
    respond: ({ toolResults }) =>
      toolResults.length === 0
        ? { toolCalls: [{ name: "notify", input: { to: "alice", text: "Hi Alice" } }] }
        : `Done: ${JSON.stringify(toolResults)}`,
  }),
});
