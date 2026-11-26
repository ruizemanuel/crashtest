// SPIKE: find and kill the process LISTENING on a TCP port (Windows / Linux / macOS).
import { spawnSync } from "node:child_process";

export function listenerPids(port) {
  if (process.platform === "win32") {
    const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" }).stdout ?? "";
    const pids = new Set();
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(re);
      if (m && m[1] !== "0") pids.add(Number(m[1]));
    }
    return [...pids];
  }
  // Linux and macOS share one POSIX path. Only the LISTEN socket: a bare `lsof -ti tcp:<port>`
  // also lists every client connected to the port (including the caller itself).
  let r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.error) r = spawnSync("fuser", [`${port}/tcp`], { encoding: "utf8" }); // lsof missing
  if (r.error) return null; // neither tool available
  return r.stdout.split(/\s+/).filter(Boolean).map(Number).filter((p) => p !== process.pid);
}

export function killPort(port) {
  const pids = listenerPids(port) ?? [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)]);
    else { try { process.kill(pid, "SIGKILL"); } catch {} }
  }
}
