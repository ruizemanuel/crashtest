// SPIKE (S3): preloaded into eve dev processes via NODE_OPTIONS=--import.
// Intercepts HTTP(S) to *.test hosts at the socket level, records each request in the
// ledger on ARRIVAL, then crashes per CT_CRASH_POINT (once per run, marker file) or
// responds as a fake provider. Inactive unless CT_LEDGER and CT_RUN_DIR are set.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequestInterceptor } from "@mswjs/interceptors/http";

const POINT = process.env.CT_CRASH_POINT ?? "none";
const LEDGER = process.env.CT_LEDGER;
const RUN = process.env.CT_RUN_DIR;

if (LEDGER && RUN) {
  mkdirSync(RUN, { recursive: true });
  const interceptor = new HttpRequestInterceptor();
  interceptor.on("request", async ({ request, controller }) => {
    const url = new URL(request.url);
    if (!url.hostname.endsWith(".test")) return; // passthrough for everything else
    const text = await request.clone().text();
    let body = text;
    try { body = JSON.parse(text); } catch {}
    appendFileSync(LEDGER, `${JSON.stringify({
      ts: new Date().toISOString(), pid: process.pid, ppid: process.ppid, kind: "http",
      method: request.method, url: request.url,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined, body,
    })}\n`);
    const marker = join(RUN, "crashed.marker");
    if ((POINT === "post-effect-fast" || POINT === "post-effect-slow") && !existsSync(marker)) {
      writeFileSync(marker, `${POINT} pid=${process.pid}`);
      if (POINT === "post-effect-slow") await new Promise((r) => setTimeout(r, 2000));
      process.kill(process.pid, "SIGKILL");
    }
    // Optional provider latency (final-review finding 2): pushes call.settled past eve's stream flush window.
    const latency = Number(process.env.CT_FAKE_LATENCY_MS ?? 0);
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    controller.respondWith(new Response(JSON.stringify({ ok: true, id: crypto.randomUUID() }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  });
  interceptor.apply();
}
