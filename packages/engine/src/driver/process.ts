import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineError } from "../errors.ts";

const IS_WIN = process.platform === "win32";

/** Locate the eve CLI installed for an app: its version and the JS entry point of `bin.eve`. */
export function resolveEveBin(appDir: string): { bin: string; version: string } {
  let pkgPath: string;
  try {
    pkgPath = createRequire(join(appDir, "package.json")).resolve("eve/package.json");
  } catch {
    throw new EngineError(`eve is not installed for ${appDir}: install the app's dependencies first`);
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; bin?: { eve?: string } };
  if (!pkg.bin?.eve) throw new EngineError(`eve ${pkg.version} at ${dirname(pkgPath)} does not declare an "eve" binary`);
  return { bin: join(dirname(pkgPath), pkg.bin.eve), version: pkg.version };
}

/** `--import=<file URL>` for NODE_OPTIONS; the URL form is required on Windows and encodes spaces. */
export function preloadImportFlag(path: string): string {
  return `--import=${pathToFileURL(path).href}`;
}

/** Append `flag` to existing NODE_OPTIONS, keeping what is already there verbatim. */
export function withPreload(existing: string | undefined, flag: string): string {
  return existing ? `${existing} ${flag}` : flag;
}

const tracked = new Set<ChildProcess>();

/**
 * Spawn a child that `killAllTracked` can find later. On POSIX the child leads its own process
 * group so `killTree` reaches its descendants too.
 */
export function spawnTracked(cmd: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(cmd, args, { ...opts, detached: !IS_WIN });
  tracked.add(child);
  child.once("exit", () => tracked.delete(child));
  child.once("error", () => {
    if (child.pid === undefined) tracked.delete(child); // never started
  });
  return child;
}

/** SIGKILL the child and everything it spawned. No-op for a child that is gone or never started. */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
  else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Last-resort cleanup (exit and signal handlers): kill every child still running. */
export function killAllTracked(): void {
  for (const child of [...tracked]) killTree(child);
}
