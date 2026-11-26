// SPIKE (throwaway): deterministic agent that calls one side-effecting tool.
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel({
    modelId: "crash-script",
    provider: "spike",
    respond: ({ toolResults }) =>
      toolResults.length === 0
        ? { toolCalls: [{ name: "send_message", input: { to: "alice", text: "Hi Alice" } }] }
        : `Done. Results: ${JSON.stringify(toolResults)}`,
  }),
});
