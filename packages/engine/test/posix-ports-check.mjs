// Regression check for src/driver/ports.ts against the built output: run `pnpm build` first.
// A process that is merely CONNECTED to the port (like the driver's own keep-alive socket)
// must never be listed or killed; only the listener is.
// Plain JS on purpose: it runs under Node 18 (e.g. WSL), which cannot load the .ts sources.
//   node test/posix-ports-check.mjs
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { freePort, killPort, listenerPids } from "../dist/driver/ports.js";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const port = await freePort();
const server = spawn(
  process.execPath,
  ["-e", `require("net").createServer(s=>s.on("error",()=>{})).listen(${port},"127.0.0.1",()=>console.log("up"))`],
  { stdio: ["ignore", "pipe", "inherit"] },
);
let client;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.stdout.on("data", (chunk) => String(chunk).includes("up") && resolve());
  });

  client = connect(port, "127.0.0.1");
  client.on("error", () => {});
  await new Promise((resolve) => client.once("connect", resolve));

  const pids = listenerPids(port) ?? [];
  check("listener pid is listed", pids.includes(server.pid), `pids=${JSON.stringify(pids)} server=${server.pid}`);
  check("connected client (self) is NOT listed", !pids.includes(process.pid), `self=${process.pid}`);

  killPort(port);
  await sleep(800);
  check("listener was killed", server.exitCode !== null || server.signalCode !== null, `exit=${server.exitCode} signal=${server.signalCode}`);
  check("checker survived", true);
} finally {
  client?.destroy();
  server.kill("SIGKILL");
}

console.log(failures === 0 ? "ALL PORT CHECKS PASSED" : `${failures} PORT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
