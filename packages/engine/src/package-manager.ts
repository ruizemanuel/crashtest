import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EngineError } from "./errors.ts";

const IS_WIN = process.platform === "win32";

export interface PackageManager {
  name: "pnpm" | "npm" | "yarn" | "bun";
  /** File name of the lockfile that identified the package manager. */
  lockfile: string;
  /** Full command line (executable first) for a reproducible install from that lockfile. */
  install: string[];
}

/** Identify the package manager from the lockfile in `appDir`; first match wins, `null` without a lockfile. */
export function detectPackageManager(appDir: string): PackageManager | null {
  const has = (file: string): boolean => existsSync(join(appDir, file));
  if (has("pnpm-lock.yaml")) return { name: "pnpm", lockfile: "pnpm-lock.yaml", install: ["pnpm", "install", "--frozen-lockfile"] };
  if (has("package-lock.json")) return { name: "npm", lockfile: "package-lock.json", install: ["npm", "ci"] };
  if (has("yarn.lock")) {
    // Yarn berry (2+) is marked by .yarnrc.yml and spells the flag --immutable.
    const install = has(".yarnrc.yml") ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"];
    return { name: "yarn", lockfile: "yarn.lock", install };
  }
  for (const lockfile of ["bun.lock", "bun.lockb"]) {
    if (has(lockfile)) return { name: "bun", lockfile, install: ["bun", "install", "--frozen-lockfile"] };
  }
  return null;
}

const OUTPUT_TAIL_CHARS = 2000;

/** Install the app's dependencies from its lockfile. Needs a lockfile so the install is reproducible. */
export function installDependencies(appDir: string): void {
  const pm = detectPackageManager(appDir);
  if (!pm) throw new EngineError(`no lockfile in ${appDir}: crashtest needs one for a reproducible install`);
  const [cmd, ...args] = pm.install;
  const options = { cwd: appDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 } as const;
  // Package managers are .cmd shims on Windows, which only a shell can launch. The command line is
  // static, so it goes in as one string (Node deprecates passing an args array together with a shell).
  const result = IS_WIN ? spawnSync(pm.install.join(" "), { ...options, shell: true }) : spawnSync(cmd, args, options);
  if (result.error) throw new EngineError(`${pm.install.join(" ")} could not run in ${appDir}: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = `${result.stdout}${result.stderr}`.trim().slice(-OUTPUT_TAIL_CHARS);
    throw new EngineError(`${pm.install.join(" ")} failed in ${appDir} (${exitLabel(result)}):\n${tail}`);
  }
}

function exitLabel(result: { status: number | null; signal: NodeJS.Signals | null }): string {
  return result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
}
