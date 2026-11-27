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

/** The oldest eve the lab can drive: earlier versions lack `mockModel` in `eve/evals` and `eve dev --resume`. */
export const MIN_EVE_VERSION = "1.2.0";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Throws an `EngineError` unless `version` (the eve installed for `appDir`) is `MIN_EVE_VERSION` or later; a prerelease of the floor is below it. */
export function assertSupportedEve(version: string, appDir: string): void {
  const match = SEMVER.exec(version);
  if (match === null) throw new EngineError(`cannot read the version of the eve installed for ${appDir} (${JSON.stringify(version)})`);
  const have = match.slice(1, 4).map(Number);
  const floor = MIN_EVE_VERSION.split(".").map(Number);
  const isPrerelease = version.startsWith(`${match.slice(1, 4).join(".")}-`);
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = have[i]! - floor[i]!;
  if (cmp < 0 || (cmp === 0 && isPrerelease)) {
    throw new EngineError(
      `eve ${version} is installed for ${appDir}, but crashtest needs eve ${MIN_EVE_VERSION} or later (older versions lack mockModel in eve/evals and eve dev --resume): upgrade eve in the app`,
    );
  }
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

/**
 * SIGKILL the child and everything it spawned. No-op for a child that never started.
 * On POSIX the whole process group is signalled even when the leader already exited: in a crash
 * cell the leader can die while a worker it started survives in its group. On Windows `taskkill /T`
 * needs a live leader to find the tree, so an exited child is skipped (callers back it up with `killPort`).
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WIN) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH: the group is already empty
  }
}

/** Last-resort cleanup (exit and signal handlers): kill every child still running. */
export function killAllTracked(): void {
  for (const child of [...tracked]) killTree(child);
}
