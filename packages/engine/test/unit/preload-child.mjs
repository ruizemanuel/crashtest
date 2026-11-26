// Child process for preload.test.ts, started with the preload imported through NODE_OPTIONS.
// Usage: node preload-child.mjs <scenario>. Every event is one JSON line on stdout, written synchronously
// so that a line printed before a self-inflicted SIGKILL is never lost.
import { writeSync } from "node:fs";
import { createServer } from "node:http";

const scenario = process.argv[2];

function say(event) {
  writeSync(1, `${JSON.stringify(event)}\n`);
}

async function send(method, url, { headers = {}, body } = {}) {
  const started = performance.now();
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Keep the raw text.
  }
  return { status: response.status, body: parsed, elapsedMs: performance.now() - started };
}

function refund(extraHeaders = {}) {
  return send("POST", "https://api.stripe.com/v1/refunds", {
    headers: { authorization: "Bearer sk_live_secret", "content-type": "application/json", ...extraHeaders },
    body: { charge: "ch_1", amount: 500 },
  });
}

async function loopback() {
  const received = [];
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, body: data });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: "loopback" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const reply = await send("POST", `http://127.0.0.1:${port}/hook`, { headers: { "content-type": "application/json" }, body: { n: 1 } });
    say({ event: "response", ...reply, received });
  } finally {
    server.close();
  }
}

switch (scenario) {
  case "idle":
    break;
  case "refund":
    say({ event: "response", ...(await refund()) });
    break;
  case "refund-keyed":
    say({ event: "response", ...(await refund({ "idempotency-key": "k1" })) });
    break;
  case "lookup-then-refund":
    say({ event: "lookup", ...(await send("GET", "https://api.stripe.com/v1/refunds?charge=ch_1", { headers: { authorization: "Bearer sk_live_secret" } })) });
    say({ event: "response", ...(await refund()) });
    break;
  case "webhook":
    say({ event: "response", ...(await send("POST", "https://hooks.slack.com/services/T0/B0/XyZsecret?key=k9", { headers: { "content-type": "application/json" }, body: { text: "hi" } })) });
    break;
  case "acme":
    say({ event: "response", ...(await send("POST", "https://api.acme.test/v1/things", { headers: { "content-type": "application/json" }, body: { n: 1 } })) });
    break;
  case "acme-empty":
    say({ event: "response", ...(await send("POST", "https://api.acme.test/empty", { headers: { "content-type": "application/json" }, body: {} })) });
    break;
  case "loopback":
    await loopback();
    break;
  default:
    throw new Error(`unknown scenario: ${scenario}`);
}

say({ event: "after" });
