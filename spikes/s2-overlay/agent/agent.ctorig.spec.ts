// "User" agent: declares a real model as a string (the overlay replaces it with a mock).
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-haiku-5.5",
});
