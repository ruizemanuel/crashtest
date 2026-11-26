// Makes the file writes of an agent's tools observable effects. It wraps the whole-file write functions of node:fs
// (writeFileSync, appendFileSync, writeFile, appendFile and their fs.promises forms), lets the real write happen
// first and then tells `record` which lab-relative file got which content. Writes through a file descriptor, a
// stream or a file handle, and every other call (rename, copy, truncate, delete, mkdir), are not observed.
//
// Runs inside the agent's own process: Node built-ins only.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type FsOp = "WRITE" | "APPEND";

export interface FsEffectsOptions {
  /** The lab: only writes to paths inside it are recorded. */
  labDir: string;
  /** The run directory holds the preload's own files and is never recorded, wherever it is. */
  runDir: string;
  /** Called after a write succeeded. May throw: the caller of the write sees the error. */
  record: (op: FsOp, relPath: string, content: string) => void;
}

type Fn = (...args: unknown[]) => unknown;
interface Observed {
  op: FsOp;
  relPath: string;
  content: string;
}

/**
 * Not effects of a tool: eve's own state and bundles (`.eve`, and `node_modules/.cache/eve`, which eve fills while
 * `eve dev` starts and runs), installed dependencies, and the operation records of crashtest's idempotency helper.
 * They are matched on the first segment of the path inside the lab.
 */
const IGNORED_SEGMENTS = new Set([".eve", "node_modules"]);
const IGNORED_PREFIX = ".crashtest";
// Windows and macOS file systems ignore case by default: `.EVE` is `.eve` there.
const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

function fold(text: string): string {
  return CASE_INSENSITIVE ? text.toLowerCase() : text;
}

function isIgnoredSegment(segment: string): boolean {
  const name = fold(segment);
  return IGNORED_SEGMENTS.has(name) || name.startsWith(IGNORED_PREFIX);
}

/** The directory as given and, when it differs, as the file system spells it (symlinks, short names). */
function rootsOf(dir: string): string[] {
  const given = resolve(dir);
  try {
    const real = fs.realpathSync(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
}

/** `target` relative to `root` with native separators, or null when it is `root` itself or not inside it. */
function insideOf(root: string, target: string): string | null {
  const rel = relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The path a write names, or null for a file descriptor, a file handle or a URL that is not a file. */
function pathOf(file: unknown): string | null {
  if (typeof file === "string") return file;
  if (Buffer.isBuffer(file)) return file.toString();
  if (file instanceof URL) {
    try {
      return fileURLToPath(file);
    } catch {
      return null;
    }
  }
  return null;
}

/** What the write puts in the file, as text; null for data this module cannot read without consuming it (iterables, streams). */
function textOf(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return null;
}

/** `{ flag: "a" }` (or the numeric O_APPEND) turns a write into an append. */
function appends(options: unknown): boolean {
  if (!isObject(options)) return false;
  const { flag } = options;
  if (typeof flag === "string") return flag.startsWith("a");
  return typeof flag === "number" && (flag & fs.constants.O_APPEND) !== 0;
}

/** Patches `target[name]` with the wrapper `make` builds around the original. */
function patch(target: object, name: string, make: (original: Fn) => Fn): void {
  const original: unknown = Reflect.get(target, name);
  if (typeof original !== "function") throw new Error(`crashtest preload: node:fs has no ${name} to observe`);
  if (!Reflect.set(target, name, make(original as Fn))) throw new Error(`crashtest preload: cannot observe node:fs ${name}`);
}

export function installFsEffects(o: FsEffectsOptions): void {
  const labRoots = rootsOf(o.labDir);
  const runRoots = rootsOf(o.runDir);

  /** The lab-relative posix path of a file the tool wrote, or null when the write is not an effect of the tool. */
  function locate(file: unknown): string | null {
    const named = pathOf(file);
    if (named === null) return null;
    const target = resolve(named);
    if (runRoots.some((root) => insideOf(root, target) !== null)) return null;
    for (const root of labRoots) {
      const rel = insideOf(root, target);
      if (rel === null) continue;
      const segments = rel.split(sep);
      return isIgnoredSegment(segments[0] ?? "") ? null : segments.join("/");
    }
    return null;
  }

  /** Looked at before the write, so a buffer that the caller reuses afterwards is read as it was written. */
  function observe(args: unknown[], alwaysAppend: boolean): Observed | null {
    const relPath = locate(args[0]);
    if (relPath === null) return null;
    const content = textOf(args[1]);
    if (content === null) return null;
    return { op: alwaysAppend || appends(args[2]) ? "APPEND" : "WRITE", relPath, content };
  }

  // appendFileSync calls fs.writeFileSync and appendFile calls fs.writeFile, now both wrapped: a call that happens
  // inside another observed call is part of it and must not be recorded again. The same goes for whatever
  // `record` writes while it runs: nothing it does is observed, so it can never trigger itself.
  let nested = 0;
  function around<T>(call: () => T): T {
    nested++;
    try {
      return call();
    } finally {
      nested--;
    }
  }

  const done = (seen: Observed): void => around(() => o.record(seen.op, seen.relPath, seen.content));

  const sync = (alwaysAppend: boolean) => (original: Fn): Fn =>
    function (this: unknown, ...args) {
      const seen = nested === 0 ? observe(args, alwaysAppend) : null;
      const result = around(() => Reflect.apply(original, this, args));
      if (seen !== null) done(seen);
      return result;
    };

  const callback = (alwaysAppend: boolean) => (original: Fn): Fn =>
    function (this: unknown, ...args) {
      const last = args.length - 1;
      const finish = args[last];
      const seen = nested === 0 && typeof finish === "function" ? observe(args, alwaysAppend) : null;
      if (seen !== null) {
        args[last] = function (this: unknown, error: unknown, ...rest: unknown[]) {
          if (error !== null && error !== undefined) return Reflect.apply(finish as Fn, this, [error, ...rest]);
          try {
            done(seen);
          } catch (failure) {
            return Reflect.apply(finish as Fn, this, [failure]);
          }
          return Reflect.apply(finish as Fn, this, [error, ...rest]);
        };
      }
      return around(() => Reflect.apply(original, this, args));
    };

  const promise = (alwaysAppend: boolean) => (original: Fn): Fn =>
    async function (this: unknown, ...args) {
      const seen = nested === 0 ? observe(args, alwaysAppend) : null;
      const result = await Reflect.apply(original, this, args);
      if (seen !== null) done(seen);
      return result;
    };

  patch(fs, "writeFileSync", sync(false));
  patch(fs, "appendFileSync", sync(true));
  patch(fs, "writeFile", callback(false));
  patch(fs, "appendFile", callback(true));
  patch(fs.promises, "writeFile", promise(false));
  patch(fs.promises, "appendFile", promise(true));
  // Code that imports `{ appendFileSync } from "node:fs"` holds the function it saw when the module was first
  // imported: this refreshes those live bindings, in node:fs and node:fs/promises.
  syncBuiltinESMExports();
}
