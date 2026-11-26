// SPIKE: regression check for ports.mjs (final-review finding 1).
// A process that is merely CONNECTED to the port (like the driver's own keep-alive
// socket) must never be listed or killed; only the listener is.
// Node 18+ compatible (runs under WSL's Node 18 and Windows' Node 24).
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { listenerPids, killPort } from "./ports.mjs";

const PORT = 2099;
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ["-e",
  `require("net").createServer(s=>s.on("error",()=>{})).listen(${PORT},"127.0.0.1",()=>console.log("up"))`]);
await new Promise((res) => server.stdout.on("data", (d) => String(d).includes("up") && res()));

const client = connect(PORT, "127.0.0.1");
client.on("error", () => {});
await new Promise((res) => client.on("connect", res));

const pids = listenerPids(PORT) ?? [];
check("listener pid is listed", pids.includes(server.pid), `pids=${JSON.stringify(pids)} server=${server.pid}`);
check("connected client (self) is NOT listed", !pids.includes(process.pid), `self=${process.pid}`);

killPort(PORT);
await sleep(800);
check("listener was killed", server.exitCode !== null || server.signalCode !== null, `exit=${server.exitCode} signal=${server.signalCode}`);
check("checker survived", true);

client.destroy();
try { server.kill("SIGKILL"); } catch {}
console.log(failures === 0 ? "ALL PORT CHECKS PASSED" : `${failures} PORT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
