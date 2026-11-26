// The zoo's real model. It is never called: the crashtest overlay always replaces it with a scripted mock.
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-haiku-5.5",
});
