// Puts the lab back to the files it was prepared with after a cell. The lab is shared by every cell of an audit
// while the fake provider starts empty for each run, so a file the tool wrote in one cell (an outbox line, a
// state file) would otherwise change what the next cell sees. Only the paths the preload recorded as file effects
// are touched, only inside the lab: each is copied back from the app, or removed when the app has no such file.
import { copyFileSync, mkdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isNeverCopied, type Lab } from "../lab.ts";
import type { LedgerEntry } from "../types.ts";

/** The lab-relative paths a ledger records as file effects, each once. A line that is not a JSON entry is skipped. */
export function writtenPaths(ledgerText: string): string[] {
  const paths = new Set<string>();
  for (const line of ledgerText.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Partial<LedgerEntry> | null;
      if (entry?.kind === "fs" && typeof entry.url === "string") paths.add(entry.url);
    } catch {
      // Not an entry: the run summary reports unreadable ledger lines.
    }
  }
  return [...paths];
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The absolute path of a lab-relative posix path, or null when it could leave the lab: absolute, empty or with `..`. */
function confined(root: string, rel: string): string | null {
  if (rel === "" || rel.includes("\0") || isAbsolute(rel) || rel.split("/").includes("..")) return null;
  const target = resolve(root, ...rel.split("/"));
  return isInside(root, target) ? target : null;
}

/** True when the nearest directory that exists above `target` really is inside the lab (no link leads out of it). */
function reallyInside(realRoot: string, target: string): boolean {
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    try {
      const real = realpathSync(dir);
      return real === realRoot || isInside(realRoot, real);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(dir) === dir) return false;
    }
  }
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Removes the directories the tool made for a file that is gone, from the innermost up, while they are empty. */
function pruneEmptyDirs(root: string, from: string): void {
  for (let dir = from; isInside(root, dir); dir = dirname(dir)) {
    try {
      rmdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; // not empty: it holds a prepared file
    }
  }
}

/**
 * Restores every path of `relPaths` to what the lab was prepared with. Returns what could not be restored, one
 * message per path; a path that leaves the lab is refused and never touched.
 */
export function restoreLabFiles(lab: Lab, relPaths: Iterable<string>): string[] {
  const root = resolve(lab.labDir);
  const problems: string[] = [];
  for (const rel of relPaths) {
    try {
      const target = confined(root, rel);
      if (target === null) {
        problems.push(`${JSON.stringify(rel)}: not a path inside the lab, left alone`);
        continue;
      }
      if (!reallyInside(realpathSync(root), target)) {
        problems.push(`${rel}: reached through a link that leaves the lab, left alone`);
        continue;
      }
      rmSync(target, { force: true, maxRetries: 3 }); // also drops a link the tool may have put there
      const source = join(lab.appDir, ...rel.split("/"));
      if (!isNeverCopied(rel) && isRegularFile(source)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      } else {
        pruneEmptyDirs(root, dirname(target));
      }
    } catch (error) {
      problems.push(`${rel}: ${(error as Error).message}`);
    }
  }
  return problems;
}
