// SPIKE (S1): real cheap model, capped, to observe callId/input stability on replay.
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-haiku-5.5",
  limits: {
    sessionUsage: ({ window }) => window.outputTokens >= 4_000 || (window.costUsd ?? 0) >= 0.02,
  },
});
