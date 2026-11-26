// SPIKE (S3): crash point "post-settle" — SIGKILL once right after eve records call.settled.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    "call.settled"() {
      if (process.env.CT_CRASH_POINT !== "post-settle") return;
      const run = process.env.CT_RUN_DIR;
      if (!run) return;
      const marker = join(run, "crashed.marker");
      if (existsSync(marker)) return;
      mkdirSync(run, { recursive: true });
      writeFileSync(marker, `post-settle pid=${process.pid}`);
      process.kill(process.pid, "SIGKILL");
    },
  },
});
