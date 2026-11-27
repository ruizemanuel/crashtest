import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertSupportedEve, preloadImportFlag, resolveEveBin, withPreload } from "./driver/process.ts";
import { EngineError } from "./errors.ts";
import { preloadPath } from "./paths.ts";

/** A disposable copy of the app. It lives inside the app, so Node finds the app's node_modules by walking up. */
export interface Lab {
  appDir: string;
  outDir: string;
  labDir: string;
  eveBin: string;
  eveVersion: string;
}

const OUT_GITIGNORE = "lab/\nlab-*/\nruns/\n";

/** Path segments that are never copied: dependencies, VCS data, runtime state and earlier audit output. */
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".eve", ".crashtest", ".vercel", ".ct-run", ".spike"]);

/** Files whose basename starts with this prefix hold secrets and are never copied. */
const SECRET_FILE_PREFIX = ".env";

/** True for a lab-relative posix path that is never copied into the lab: excluded directories and secret files. */
export function isNeverCopied(rel: string): boolean {
  return rel.split("/").some((s) => EXCLUDED_SEGMENTS.has(s)) || rel.slice(rel.lastIndexOf("/") + 1).startsWith(SECRET_FILE_PREFIX);
}

/** Copy the app into a fresh lab directory and return where eve lives for it. The source tree is never modified. */
export function createLab(appDir: string, opts: { outDir?: string; labDir?: string } = {}): Lab {
  const app = resolve(appDir);
  const outDir = resolve(opts.outDir ?? join(app, ".crashtest"));
  const labDir = resolve(opts.labDir ?? join(outDir, "lab"));
  assertLabLayout(app, outDir, labDir);

  // The lab sits inside the app, so eve resolves upward; failing here touches nothing on disk.
  const eve = resolveEveBin(labDir);
  assertSupportedEve(eve.version, app);

  // The output directory (and the lab in it) is never copied into the lab itself.
  const outputDirs = [toPosix(relative(app, outDir))];
  const excludedDir = (rel: string): boolean => rel.split("/").some((s) => EXCLUDED_SEGMENTS.has(s)) || underAny(rel, outputDirs);
  const excludedFile = (rel: string): boolean => isNeverCopied(rel) || underAny(rel, outputDirs);

  rmSync(labDir, { recursive: true, force: true, maxRetries: 3 });
  for (const rel of listSourceFiles(app, excludedDir).filter((f) => !excludedFile(f))) {
    const from = join(app, ...rel.split("/"));
    if (!isRegularFile(from)) continue; // tracked but deleted, a submodule, or a dangling symlink
    const to = join(labDir, ...rel.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, ".gitignore"), OUT_GITIGNORE);

  return { appDir: app, outDir, labDir, eveBin: eve.bin, eveVersion: eve.version };
}

/** Delete the lab copy. The output directory (runs, reports) stays. Refuses a lab that is not where `createLab` puts it. */
export function removeLab(lab: Lab): void {
  assertLabLayout(resolve(lab.appDir), resolve(lab.outDir), resolve(lab.labDir));
  rmSync(lab.labDir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * The directory layout that makes wiping the lab safe: the output directory is strictly inside the
 * app (Node then finds the app's node_modules upward) and the lab is strictly inside the output
 * directory, so a wipe can never reach the app's own files, `.git` or `node_modules`.
 */
function assertLabLayout(app: string, outDir: string, labDir: string): void {
  if (!strictlyInside(app, outDir)) {
    throw new EngineError(`the output directory ${outDir} must be inside the app ${app}, so Node can find the app's node_modules`);
  }
  if (!strictlyInside(outDir, labDir)) {
    throw new EngineError(`the lab ${labDir} must be inside the output directory ${outDir}: only that directory is ever wiped`);
  }
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE/i;
const SECRET_PREFIX = /^(VERCEL_|AI_GATEWAY_|ANTHROPIC_|OPENAI_)/i;
/** A URL with a password in it: `scheme://user:pass@` (the user may be empty). */
const URL_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*:[^\s/?#@]*@/i;
/** Every `scheme://` in a value. */
const URL_SCHEME = /([a-z][a-z0-9+.-]*):\/\//gi;
/**
 * Schemes of servers that the preload neither fakes nor blocks (it answers HTTP only): databases, caches, queues and
 * mail. Matched against each `+`-separated part of a scheme, so `mongodb+srv` and `prisma+postgres` count.
 */
const SERVER_SCHEMES = new Set([
  "postgres",
  "postgresql",
  "cockroachdb",
  "mysql",
  "mariadb",
  "mssql",
  "sqlserver",
  "mongodb",
  "clickhouse",
  "libsql",
  "redis",
  "rediss",
  "valkey",
  "memcached",
  "amqp",
  "amqps",
  "nats",
  "kafka",
  "smtp",
  "smtps",
]);

/** True for a value with URL credentials or the URL of a database, cache, queue or mail server. */
function carriesConnection(value: string): boolean {
  if (URL_CREDENTIALS.test(value)) return true;
  for (const [, scheme] of value.matchAll(URL_SCHEME)) {
    if ((scheme ?? "").toLowerCase().split("+").some((part) => SERVER_SCHEMES.has(part))) return true;
  }
  return false;
}

/**
 * The environment for processes that run the lab: `base` without credential-looking variables and without values
 * that carry URL credentials or point at a server that is not HTTP (a database URL in a variable named anything),
 * then `extra` on top. Variables in `extra` (the config `env` and `CT_*`) are explicit and always win.
 */
export function labEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name) || SECRET_PREFIX.test(name) || carriesConnection(value)) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/**
 * The environment for an eve process that runs in the lab with the preload (discovery and cells):
 * `labEnv` over `base` without any `CT_*` left over from the caller, then `extra`, with eve CLI telemetry
 * off and the preload appended to NODE_OPTIONS (the one in `extra`, else the one in `base`).
 * Telemetry is off because the CLI reports from a detached process that outlives the command and, during a
 * crash cell, reports the unexpected exit, which would otherwise land in the ledger as an effect.
 */
export function preloadedLabEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(base).filter(([name]) => !/^CT_/i.test(name)));
  return labEnv(kept, {
    ...extra,
    EVE_TELEMETRY_DISABLED: "1",
    NODE_OPTIONS: withPreload(extra.NODE_OPTIONS ?? kept.NODE_OPTIONS, preloadImportFlag(preloadPath())),
  });
}

/**
 * Relative posix paths of the files to consider copying: what git would track or show as untracked
 * (honoring .gitignore) when the app is in a git work tree, otherwise (or when git lists nothing,
 * as for an app inside an ignored directory) a plain walk that prunes excluded directories.
 */
function listSourceFiles(app: string, excludedDir: (rel: string) => boolean): string[] {
  const viaGit = gitFileList(app);
  return viaGit.length > 0 ? viaGit : walk(app, "", excludedDir);
}

function gitFileList(app: string): string[] {
  const result = spawnSync("git", ["-C", app, "ls-files", "-co", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return []; // git missing, not a work tree, or unreadable
  return [...new Set(result.stdout.split("\0").filter((p) => p !== ""))];
}

function walk(root: string, rel: string, excludedDir: (rel: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, ...rel.split("/").filter(Boolean)), { withFileTypes: true })) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!excludedDir(childRel)) out.push(...walk(root, childRel, excludedDir));
    } else {
      out.push(childRel); // files, and symlinks (checked for being regular files at copy time)
    }
  }
  return out;
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function underAny(rel: string, dirs: string[]): boolean {
  return dirs.some((dir) => rel === dir || rel.startsWith(`${dir}/`));
}
