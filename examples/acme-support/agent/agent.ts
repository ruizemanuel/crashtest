// The support agent's model, capped so a real session stays cheap. Crashtest never calls it: its lab replaces the
// model with a scripted mock.
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-haiku-5.5",
  limits: {
    sessionUsage: ({ window }) => window.outputTokens >= 4_000 || (window.costUsd ?? 0) >= 0.02,
  },
});
