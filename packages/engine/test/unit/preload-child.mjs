// Child process for preload.test.ts, started with the preload imported through NODE_OPTIONS.
// Usage: node preload-child.mjs <scenario>. Every event is one JSON line on stdout, written synchronously
// so that a line printed before a self-inflicted SIGKILL is never lost.
// The file-system scenarios run with the lab as the working directory, and import node:fs the way eve's tool code
// does (named ESM imports, which only see the preload's wrappers after syncBuiltinESMExports).
import { spawnSync } from "node:child_process";
import fs, { appendFile, appendFileSync, closeSync, createWriteStream, mkdirSync, openSync, writeFile, writeFileSync, writeSync } from "node:fs";
import fsp, { appendFile as appendFilePromise, writeFile as writeFilePromise } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const OUTBOX_LINE = `${JSON.stringify({ to: "alice", orderId: "ord_1" })}\n`;

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

const done = (call) => new Promise((resolve, reject) => call((error) => (error ? reject(error) : resolve())));

switch (scenario) {
  case "idle":
    break;
  case "fs-append":
    mkdirSync("data", { recursive: true });
    appendFileSync("data/outbox.jsonl", OUTBOX_LINE);
    break;
  case "fs-append-callback":
    mkdirSync("data", { recursive: true });
    await done((cb) => appendFile("data/outbox.jsonl", OUTBOX_LINE, cb));
    break;
  case "fs-append-promise":
    mkdirSync("data", { recursive: true });
    await appendFilePromise("data/outbox.jsonl", OUTBOX_LINE);
    break;
  case "fs-forms": {
    mkdirSync("data", { recursive: true });
    writeFileSync("data/a.txt", "one");
    appendFileSync("data/b.log", "two\n");
    writeFileSync("data/c.log", "three\n", { flag: "a" });
    await done((cb) => writeFile("data/d.txt", "four", cb));
    await done((cb) => appendFile("data/e.log", "five\n", "utf8", cb));
    await fs.promises.writeFile("data/f.txt", "six");
    await writeFilePromise("data/g.txt", Buffer.from("seven"));
    await fsp.appendFile("data/h.log", "eight\n");
    writeFileSync(pathToFileURL(join(process.cwd(), "data", "i.txt")), "nine");
    writeFileSync(join(process.cwd(), "data", "..", "data", "j.txt"), new Uint8Array(Buffer.from("ten")));
    break;
  }
  case "fs-ignored": {
    for (const dir of [".eve", ".crashtest-idempotency", "node_modules/pkg", ".eve-notes", "data"]) mkdirSync(dir, { recursive: true });
    writeFileSync(".eve/x.json", "{}");
    writeFileSync(".crashtest-idempotency/k.json", '{"status":"started"}', { flag: "wx" });
    writeFileSync("node_modules/pkg/index.js", "1");
    writeFileSync(join(process.env.CT_TEST_OUTSIDE, "outside.txt"), "outside");
    writeFileSync(join(process.env.CT_RUN_DIR, "note.txt"), "in the run directory");
    // Only the first segment is matched, and exactly: these two are effects.
    writeFileSync(".eve-notes/n.txt", "notes");
    writeFileSync("data/kept.txt", "kept");
    break;
  }
  case "fs-unobserved": {
    mkdirSync("data", { recursive: true });
    const fd = openSync("data/fd.txt", "w");
    writeFileSync(fd, "through a descriptor");
    writeSync(fd, "again");
    closeSync(fd);
    const stream = createWriteStream("data/stream.txt");
    await new Promise((resolve, reject) => stream.once("error", reject).end("through a stream", resolve));
    break;
  }
  case "fs-write-repeat":
    mkdirSync("data", { recursive: true });
    writeFileSync("data/state.json", '{"a":1}');
    writeFileSync("data/state.json", '{"a":1}');
    writeFileSync("data/state.json", '{"a":2}');
    break;
  case "fs-large": {
    const head = "x".repeat(3000);
    writeFileSync("big.txt", `${head}A`);
    writeFileSync("big.txt", `${head}B`);
    writeFileSync("big.txt", `${head}B`);
    break;
  }
  case "fs-spied": {
    // A spy above the preload's wrappers: it sees every call that reaches a wrapped (public) node:fs function.
    const reached = [];
    for (const [target, names] of [[fs, ["writeFileSync", "appendFileSync", "writeFile", "appendFile"]], [fs.promises, ["writeFile", "appendFile"]]]) {
      for (const name of names) {
        const inner = target[name];
        target[name] = function (...args) {
          reached.push(String(args[0]));
          return inner.apply(this, args);
        };
      }
    }
    mkdirSync("data", { recursive: true });
    await refund(); // the preload ledgers it and saves its state in the run directory
    fs.appendFileSync("data/outbox.jsonl", OUTBOX_LINE); // the same for a file effect
    await fs.promises.appendFile("data/outbox.jsonl", OUTBOX_LINE);
    say({ event: "reached", paths: reached });
    break;
  }
  case "fs-child-process":
    mkdirSync("data", { recursive: true });
    // A Node child inherits NODE_OPTIONS and the CT_* variables, so it loads the preload too.
    spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync('data/from-child.txt', 'from a child')"], { stdio: "ignore" });
    break;
  case "fs-secret":
    writeFileSync("small.json", JSON.stringify({ password: "hunter2", n: 1 }));
    writeFileSync("large.json", JSON.stringify({ apiKey: "hunter2", items: Array.from({ length: 400 }, (_, i) => `item-${i}`) }));
    break;
  case "fs-failed":
    mkdirSync("data", { recursive: true });
    for (const attempt of [() => appendFileSync("missing/dir/outbox.jsonl", OUTBOX_LINE), () => writeFileSync("data", "x"), () => writeFileSync("data/kept.txt", "x", { flag: "wx" }), () => writeFileSync("data/kept.txt", "x", { flag: "wx" })]) {
      try {
        attempt();
        say({ event: "wrote" });
      } catch (error) {
        say({ event: "failed", code: error.code });
      }
    }
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
  case "telemetry-then-refund":
    // A telemetry POST before the tool's own effect: a mutating request that is not the tool's.
    say({ event: "telemetry", ...(await send("POST", "https://telemetry.acme.test/v1/events", { headers: { "content-type": "application/json" }, body: { event: "start" } })) });
    say({ event: "response", ...(await refund()) });
    break;
  case "token-then-notify":
    // A token exchange sent as a POST before the tool's own effect, as Vercel Connect does: a read, not an effect.
    say({ event: "token", ...(await send("POST", "https://api.vercel.com/v1/connect/token/slack%2Fsre", { headers: { "content-type": "application/json" }, body: {} })) });
    say({ event: "response", ...(await send("POST", "https://api.acme-notify.test/v1/messages", { headers: { "content-type": "application/json" }, body: { to: "alice", text: "hi" } })) });
    break;
  case "fs-build-then-append":
    // Build output written inside the lab before the tool's own effect.
    mkdirSync(".next", { recursive: true });
    mkdirSync("data", { recursive: true });
    writeFileSync(".next/build-manifest.json", "{}");
    say({ event: "built" });
    appendFileSync("data/outbox.jsonl", OUTBOX_LINE);
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
