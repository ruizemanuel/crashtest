import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

const IS_WIN = process.platform === "win32";

/**
 * Pids LISTENing on `port`, parsed from `netstat -ano` output. Locale independent: the state word
 * ("LISTENING", "ESCUCHANDO", ...) is never read; a LISTEN row is one whose foreign address is
 * the wildcard `0.0.0.0:0` or `[::]:0`.
 */
export function parseNetstatListeners(output: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !cols[0]!.startsWith("TCP")) continue;
    const [, local, foreign] = cols as [string, string, string];
    if (foreign !== "0.0.0.0:0" && foreign !== "[::]:0") continue;
    if (local.slice(local.lastIndexOf(":") + 1) !== String(port)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/**
 * Pids LISTENing on `port`, never including this process. `null` when no tool to find them is
 * available. Only the LISTEN socket counts: a bare `lsof -ti tcp:<port>` also lists every client
 * connected to the port, including the caller's own keep-alive sockets.
 */
export function listenerPids(port: number): number[] | null {
  if (IS_WIN) {
    const results = ["TCP", "TCPv6"].map((proto) => spawnSync("netstat", ["-ano", "-p", proto], { encoding: "utf8" }));
    if (results.every((r) => r.error)) return null;
    const pids = new Set<number>();
    for (const r of results) for (const pid of parseNetstatListeners(r.stdout ?? "", port)) pids.add(pid);
    pids.delete(process.pid);
    return [...pids];
  }
  // Linux and macOS share one POSIX path.
  let r = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
  if (r.error) r = spawnSync("fuser", [`${port}/tcp`], { encoding: "utf8" }); // lsof missing
  if (r.error) return null; // neither tool available
  return r.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
}

/** SIGKILL whatever is listening on `port` (and its tree on Windows); never this process. */
export function killPort(port: number): void {
  for (const pid of listenerPids(port) ?? []) {
    if (pid === process.pid) continue;
    if (IS_WIN) spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
    else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
}

/** Ask the OS for a free loopback port: listen on port 0, read it, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not read the port assigned by the OS"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
