import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { freePort } from "../../src/driver/ports.ts";
import { answerApproval, readSessionStream, runCell } from "../../src/driver/run-cell.ts";
import type { Lab } from "../../src/lab.ts";

/** A local HTTP server answering with `handler`; closed after the test. Returns its base URL. */
async function serve(t: TestContext, handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => handler(req, body, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const signal = (): AbortSignal => AbortSignal.timeout(5000);

test("readSessionStream parses the recorded history", async (t) => {
  const base = await serve(t, (req, _body, res) => {
    assert.equal(req.url, "/eve/v1/session/wrun_A/stream?follow=false");
    res.end(`${JSON.stringify({ facts: [{ type: "turn.settled", data: { outcome: "completed" } }] })}\n`);
  });
  const read = await readSessionStream(base, "wrun_A", signal());
  assert.ok(read.ok);
  assert.equal(read.stream.turnOutcome, "completed");
});

test("readSessionStream reports a gone session (404/410) as terminal, with status and body", async (t) => {
  for (const status of [404, 410]) {
    const base = await serve(t, (_req, _body, res) => {
      res.statusCode = status;
      res.end('{"error":"session_gone"}');
    });
    const read = await readSessionStream(base, "wrun_A", signal());
    assert.ok(!read.ok);
    assert.equal(read.terminal, true);
    assert.match(read.problem, new RegExp(`HTTP ${status}`));
    assert.match(read.problem, /session_gone/);
  }
});

test("readSessionStream reports other failures as retryable", async (t) => {
  const base = await serve(t, (_req, _body, res) => {
    res.statusCode = 503;
    res.end("busy");
  });
  const busy = await readSessionStream(base, "wrun_A", signal());
  assert.ok(!busy.ok);
  assert.equal(busy.terminal, false);
  assert.match(busy.problem, /HTTP 503 busy/);

  const refused = await readSessionStream(`http://127.0.0.1:${await freePort()}`, "wrun_A", signal());
  assert.ok(!refused.ok);
  assert.equal(refused.terminal, false);
  assert.match(refused.problem, /stream read failed: \S/);
});

test("answerApproval sends the approve option and reports a rejected answer with status and body", async (t) => {
  const received: string[] = [];
  const base = await serve(t, (req, body, res) => {
    received.push(`${req.method} ${req.url} ${body}`);
    res.statusCode = body.includes("req_bad") ? 400 : 200;
    res.end(res.statusCode === 200 ? '{"ok":true}' : '{"error":"unknown_option"}');
  });
  assert.deepEqual(await answerApproval(base, "wrun_A", "req_ok", signal()), { ok: true });
  const rejected = await answerApproval(base, "wrun_A", "req_bad", signal());
  assert.ok(!rejected.ok);
  assert.match(rejected.problem, /req_bad/);
  assert.match(rejected.problem, /HTTP 400 \{"error":"unknown_option"\}/);
  assert.deepEqual(received[0], `POST /eve/v1/session/wrun_A ${JSON.stringify({ answers: [{ interactionId: "req_ok", optionId: "approve" }] })}`);
});

/**
 * A stand-in for `eve dev`: prints the ready line and serves health, session create, a stream and answers.
 * Mode "stream-gone": the stream answers 410. Mode "approval-rejected": the stream shows an open approval
 * that never settles and every answer gets a 400. Mode "record-env": as "stream-gone", after writing the
 * CT_EFFECTS_IGNORE it was started with to stub-env.json in the run directory.
 */
const STUB_EVE = `const http = require("node:http");
const fs = require("node:fs");
const mode = fs.readFileSync("stub-mode", "utf8").trim();
if (mode === "record-env") fs.writeFileSync(require("node:path").join(process.env.CT_RUN_DIR, "stub-env.json"), JSON.stringify({ ignore: process.env.CT_EFFECTS_IGNORE ?? null }));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://stub").pathname;
  if (path === "/eve/v1/health") return res.end('{"ok":true}');
  if (req.method === "POST" && path === "/eve/v1/session") return res.end('{"ok":true,"sessionId":"wrun_stub"}');
  if (path === "/eve/v1/session/wrun_stub/stream") {
    if (mode !== "approval-rejected") { res.statusCode = 410; return res.end('{"error":"session_gone"}'); }
    return res.end(JSON.stringify({ facts: [{ type: "interaction.opened", data: { interactionId: "req_1" } }] }) + "\\n");
  }
  if (req.method === "POST" && path === "/eve/v1/session/wrun_stub") { res.statusCode = 400; return res.end('{"error":"unknown_option"}'); }
  res.statusCode = 404;
  res.end();
});
server.listen(port, "127.0.0.1", () => console.log("[DEV] ready at http://127.0.0.1:" + port + "/"));
`;

function stubLab(t: TestContext, mode: string): Lab {
  const root = mkdtempSync(join(tmpdir(), "ct-run-cell-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const outDir = join(root, "app", ".crashtest");
  const labDir = join(outDir, "lab");
  mkdirSync(labDir, { recursive: true });
  writeFileSync(join(labDir, "stub-mode"), mode);
  const eveBin = join(root, "eve-stub.cjs");
  writeFileSync(eveBin, STUB_EVE);
  return { appDir: join(root, "app"), outDir, labDir, eveBin, eveVersion: "0.0.0-stub" };
}

function stubCell(lab: Lab, timeoutMs: number): Parameters<typeof runCell>[0] {
  return {
    lab,
    tool: { name: "naive", file: "agent/tools/naive.ts", inputSchema: null },
    cell: { id: "baseline-1", point: "none", idMode: "stable", latencyMs: 0, holdMs: 0 },
    attempt: 1,
    input: {},
    freeTextFields: [],
    config: {},
    timeoutMs,
  };
}

test("runCell ends on a gone stream with the HTTP status and body instead of waiting for the deadline", async (t) => {
  const summary = await runCell(stubCell(stubLab(t, "stream-gone"), 60_000));
  t.diagnostic(`${summary.turnOutcome}: ${summary.error}`);
  assert.equal(summary.turnOutcome, "stream-failed");
  assert.match(summary.error ?? "", /HTTP 410 \{"error":"session_gone"\}/);
  assert.ok(summary.wallMs < 30_000, `ended early (${summary.wallMs} ms)`);
});

test("runCell hands effects.ignore to the preloaded server as CT_EFFECTS_IGNORE", async (t) => {
  const seen = async (config: Parameters<typeof runCell>[0]["config"]): Promise<unknown> => {
    const summary = await runCell({ ...stubCell(stubLab(t, "record-env"), 60_000), config });
    assert.equal(summary.turnOutcome, "stream-failed", summary.error);
    return JSON.parse(readFileSync(join(summary.runDir, "stub-env.json"), "utf8"));
  };
  assert.deepEqual(await seen({ effects: { ignore: ["https://api.vercel.com/v1/connect/*", ".next/*"] } }), {
    ignore: JSON.stringify(["https://api.vercel.com/v1/connect/*", ".next/*"]),
  });
  // Always set, so a CT_EFFECTS_IGNORE that the config's `env` names cannot stand in for the ignore list.
  assert.deepEqual(await seen({ env: { CT_EFFECTS_IGNORE: JSON.stringify(["*"]) } }), { ignore: "[]" });
});

test("runCell reports the last rejected approval answer when the turn does not settle", async (t) => {
  const summary = await runCell(stubCell(stubLab(t, "approval-rejected"), 4000));
  t.diagnostic(`${summary.turnOutcome}: ${summary.error}`);
  assert.equal(summary.turnOutcome, "timeout");
  assert.equal(summary.approvals, 0);
  assert.match(summary.error ?? "", /did not settle within 4 s/);
  assert.match(summary.error ?? "", /req_1.*HTTP 400 \{"error":"unknown_option"\}/);
});
