import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { test } from "node:test";
import { freePort, killPort, listenerPids, parseNetstatListeners } from "../../src/driver/ports.ts";

const EN =
  "  TCP    127.0.0.1:4100   0.0.0.0:0   LISTENING   111\n" +
  "  TCP    127.0.0.1:4100   127.0.0.1:5000   ESTABLISHED   222\n" +
  "  TCP    [::]:4100   [::]:0   LISTENING   333";
const ES = EN.replaceAll("LISTENING", "ESCUCHANDO").replaceAll("ESTABLISHED", "ESTABLECIDO");

test("netstat parsing ignores the state word", () => {
  assert.deepEqual(parseNetstatListeners(EN, 4100), [111, 333]);
  assert.deepEqual(parseNetstatListeners(ES, 4100), [111, 333]);
  assert.deepEqual(parseNetstatListeners(EN, 41000), []);
});

test("netstat parsing matches the local port exactly, dedupes and skips pid 0", () => {
  const out = [
    "  TCP    0.0.0.0:14100   0.0.0.0:0   LISTENING   1",
    "  TCP    0.0.0.0:4100    0.0.0.0:0   LISTENING   444",
    "  TCP    [::]:4100       [::]:0      LISTENING   444",
    "  TCP    0.0.0.0:4100    0.0.0.0:0   LISTENING   0",
    "  UDP    0.0.0.0:4100    *:*                     555",
  ].join("\r\n");
  assert.deepEqual(parseNetstatListeners(out, 4100), [444]);
});

test("freePort returns a bindable local port", async () => {
  const port = await freePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `port=${port}`);
});

function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

test("killPort kills the listener, never a connected client or itself", async () => {
  const port = await freePort();
  const server = spawn(
    process.execPath,
    ["-e", `require("net").createServer(s=>s.on("error",()=>{})).listen(${port},"127.0.0.1",()=>console.log("up"))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let client: Socket | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.stdout!.on("data", (chunk: Buffer) => String(chunk).includes("up") && resolve());
    });
    const connected = connect(port, "127.0.0.1");
    client = connected;
    connected.on("error", () => {});
    await new Promise<void>((resolve) => connected.once("connect", resolve));

    const pids = listenerPids(port) ?? [];
    assert.ok(pids.includes(server.pid!), `listener pid listed: pids=${JSON.stringify(pids)} server=${server.pid}`);
    assert.ok(!pids.includes(process.pid), "connected client (self) is not listed");

    killPort(port);
    assert.ok(await exited(server, 5000), "listener was killed");
  } finally {
    client?.destroy();
    server.kill("SIGKILL");
  }
});
