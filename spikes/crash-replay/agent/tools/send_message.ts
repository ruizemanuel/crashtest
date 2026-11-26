// SPIKE: crash-harness wrapper generated around the user's tool (no edits to the original).
// Crash point "after-effect": the original execute resolved (effect landed) but eve
// hasn't recorded the result yet.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "eve/tools";
import original from "../lib/orig/send_message";

const SPIKE_DIR = process.env.SPIKE_DIR ?? join(process.cwd(), ".spike");

export default defineTool({
  ...original,
  async execute(input, ctx) {
    const result = await original.execute(input, ctx);
    const marker = join(SPIKE_DIR, "crashed.marker");
    if (process.env.SPIKE_CRASH === "1" && !existsSync(marker)) {
      mkdirSync(SPIKE_DIR, { recursive: true });
      writeFileSync(marker, String(process.pid));
      process.kill(process.pid, "SIGKILL");
    }
    return result;
  },
});
