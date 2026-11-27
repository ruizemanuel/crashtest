import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { EngineError } from "../../src/errors.ts";
import type { CodemodFile } from "../../src/fix/codemod.ts";
import { applyFix, fixSummary, isImprovement, patchOf, usableRatings, type FixCandidate, type FixOutcome } from "../../src/fix/fix.ts";
import type { CellId, CellVerdict, Report, ToolRating, VerdictKind } from "../../src/types.ts";
import { verdict } from "./builders.ts";

const BANNED = /\b(verified|safe)\b/i;

/** A rating of `naive` with one verdict per listed cell. */
function rating(stars: ToolRating["stars"], kinds: Partial<Record<CellId, VerdictKind>>, partial: Partial<ToolRating> = {}): ToolRating {
  const cells: CellVerdict[] = Object.entries(kinds).map(([cellId, kind]) => verdict({ cellId: cellId as CellId, kind }));
  return {
    tool: "naive",
    stars,
    approval: false,
    benignRepeats: false,
    identity: ["to", "orderId"],
    summary: "",
    recommendation: "",
    cells,
    ...partial,
  };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-fix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, path: string, text: string): void {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function read(root: string, path: string): string | null {
  const file = join(root, ...path.split("/"));
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

const TOOL = "agent/tools/naive.ts";
const HELPER = "agent/lib/crashtest-idempotency.ts";
const FILES: CodemodFile[] = [
  { path: TOOL, before: "export default 1;\r\nconst text = 'x';", after: "import { once } from '../lib/crashtest-idempotency';\r\nexport default once;\r\nconst text = 'x';" },
  { path: HELPER, before: null, after: "export function once() {}\n" },
];

function candidate(partial: Partial<FixCandidate> = {}): FixCandidate {
  return { strategy: "ledger-guard", applied: true, files: FILES, after: rating(5, {}), runs: 14, wallMs: 180_000, eveVersion: "1.5.0", ...partial };
}

function outcome(partial: Partial<FixOutcome> = {}): FixOutcome {
  const chosen = candidate();
  return {
    tool: "naive",
    identity: ["to", "orderId"],
    before: rating(1, { "post-effect-fast-stable": "dup" }),
    candidates: [{ strategy: "upstream-key", applied: false, reason: "no fetch call to an idempotency-capable host" }, chosen],
    chosen,
    patchPath: ".crashtest/fix/naive.patch",
    ...partial,
  };
}

// ---------------------------------------------------------------- isImprovement

test("1 to 5 stars with every cell cleaner is an improvement", () => {
  const before = rating(1, { "post-effect-fast-stable": "dup", "post-effect-fast-fresh": "dup", "post-effect-slow": "dup", "post-settle": "clean" });
  const after = rating(5, { "post-effect-fast-stable": "clean", "post-effect-fast-fresh": "clean", "post-effect-slow": "clean", "post-settle": "clean" });
  assert.equal(isImprovement(before, after), true);
});

test("more stars but one cell going from clean to phantom-failure is no improvement", () => {
  const before = rating(3, { "post-effect-fast-stable": "clean", "post-effect-fast-fresh": "dup", "post-effect-slow": "dup", "post-settle": "clean" });
  const after = rating(4, { "post-effect-fast-stable": "phantom-failure", "post-effect-fast-fresh": "clean", "post-effect-slow": "clean", "post-settle": "clean" });
  assert.equal(isImprovement(before, after), false);
});

test("a rating that is not evaluated is never an improvement", () => {
  const before = rating(1, { "post-effect-fast-stable": "dup" });
  assert.equal(isImprovement(before, rating(null, {}, { na: { reason: "baseline-failed", detail: "the baseline failed" } })), false);
  assert.equal(isImprovement(rating(null, {}), rating(5, { "post-effect-fast-stable": "clean" })), false);
});

test("the same number of stars is no improvement, even with cleaner cells", () => {
  const before = rating(3, { "post-effect-fast-fresh": "dup", "post-effect-slow": "dup" });
  const after = rating(3, { "post-effect-fast-fresh": "dup", "post-effect-slow": "clean" });
  assert.equal(isImprovement(before, after), false);
});

test("a cell in only one of the two ratings is not compared", () => {
  const before = rating(1, { "post-effect-fast-stable": "dup" });
  const after = rating(4, { "post-effect-fast-stable": "clean", "post-settle": "lost-effect" });
  assert.equal(isImprovement(before, after), true);
});

test("severity orders clean, then phantom-failure and lost-effect, then dup, then invalid", () => {
  const cell = "post-effect-slow";
  const pairs: [VerdictKind, VerdictKind, boolean][] = [
    ["dup", "phantom-failure", true],
    ["dup", "lost-effect", true],
    ["phantom-failure", "lost-effect", true],
    ["phantom-failure", "dup", false],
    ["invalid", "dup", true],
    ["dup", "invalid", false],
  ];
  for (const [from, to, expected] of pairs) {
    assert.equal(isImprovement(rating(1, { [cell]: from }), rating(4, { [cell]: to })), expected, `${from} -> ${to}`);
  }
});

// ---------------------------------------------------------------- patch

test("the patch diffs a/<path> to b/<path> and creates new files from /dev/null", () => {
  const patch = patchOf(FILES);
  assert.match(patch, /^--- a\/agent\/tools\/naive\.ts\n\+\+\+ b\/agent\/tools\/naive\.ts\n@@ /m);
  assert.match(patch, /^--- \/dev\/null\n\+\+\+ b\/agent\/lib\/crashtest-idempotency\.ts\n@@ -0,0 \+1,1 @@\n\+export function once\(\) \{\}\n/m);
  assert.doesNotMatch(patch, /^={10,}$/m, "no jsdiff underline between files");
});

test("git apply turns the original files into the patched ones", (t) => {
  const dir = tempDir(t);
  for (const file of FILES) if (file.before !== null) write(dir, file.path, file.before);
  writeFileSync(join(dir, "fix.patch"), patchOf(FILES));
  const result = spawnSync("git", ["apply", "fix.patch"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const file of FILES) assert.equal(read(dir, file.path), file.after, file.path);
});

// ---------------------------------------------------------------- applyFix

test("applyFix writes the chosen candidate's files into the app", (t) => {
  const app = tempDir(t);
  write(app, TOOL, FILES[0]!.before!);
  applyFix(app, outcome());
  for (const file of FILES) assert.equal(read(app, file.path), file.after, file.path);
});

test("applyFix writes nothing when a file changed since the fix was made", (t) => {
  const app = tempDir(t);
  write(app, TOOL, "edited by hand");
  assert.throws(() => applyFix(app, outcome()), (err: unknown) => err instanceof EngineError && err.message.includes(TOOL));
  assert.equal(read(app, TOOL), "edited by hand");
  assert.equal(read(app, HELPER), null, "the helper is not written either");
});

test("applyFix writes nothing when a file the fix creates already exists", (t) => {
  const app = tempDir(t);
  write(app, TOOL, FILES[0]!.before!);
  write(app, HELPER, "the user's own helper");
  assert.throws(() => applyFix(app, outcome()), (err: unknown) => err instanceof EngineError && err.message.includes(HELPER));
  assert.equal(read(app, TOOL), FILES[0]!.before);
  assert.equal(read(app, HELPER), "the user's own helper");
});

test("applyFix refuses paths that leave the app and writes nothing", (t) => {
  const root = tempDir(t);
  const app = join(root, "app");
  write(app, TOOL, FILES[0]!.before!);
  for (const path of ["../outside.ts", "agent/../../outside.ts", "/outside.ts", "C:/outside.ts", "agent\\..\\..\\outside.ts", "", "agent//x.ts"]) {
    const files = [FILES[0]!, { path, before: null, after: "x" }];
    const bad = outcome({ chosen: candidate({ files }) });
    assert.throws(() => applyFix(app, bad), EngineError, JSON.stringify(path));
    assert.equal(read(app, TOOL), FILES[0]!.before, `the tool file is untouched for ${JSON.stringify(path)}`);
  }
  assert.equal(read(root, "outside.ts"), null);
});

test("applyFix does nothing without a chosen candidate", (t) => {
  const app = tempDir(t);
  write(app, TOOL, "original");
  applyFix(app, outcome({ chosen: null, patchPath: null }));
  assert.equal(read(app, TOOL), "original");
  assert.equal(read(app, HELPER), null);
});

// ---------------------------------------------------------------- summary

test("a chosen ledger-guard prints the lab result, the trade-off and the store note", () => {
  const text = fixSummary(outcome());
  assert.equal(
    text,
    "In lab: naive ★☆☆☆☆ → ★★★★★ with ledger-guard (14 runs, eve 1.5.0). Patch: .crashtest/fix/naive.patch\n" +
      "Trade-off: a second legitimate call with the same identity (to, orderId) in the same turn is blocked.\n" +
      "In lab with the file store; set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for a durable store in production.\n",
  );
  assert.doesNotMatch(text, BANNED);
});

test("a chosen upstream-key prints only the lab result", () => {
  const chosen = candidate({ strategy: "upstream-key", after: rating(4, {}), runs: 11 });
  const text = fixSummary(outcome({ before: rating(2, {}), candidates: [chosen], chosen }));
  assert.equal(text, "In lab: naive ★★☆☆☆ → ★★★★☆ with upstream-key (11 runs, eve 1.5.0). Patch: .crashtest/fix/naive.patch\n");
});

test("without a chosen candidate nothing is claimed", () => {
  assert.equal(fixSummary(outcome({ chosen: null, patchPath: null })), "No candidate improved naive; nothing written.\n");
  assert.equal(fixSummary(outcome({ before: rating(5, {}), candidates: [], chosen: null, patchPath: null })), "No fix needed for naive: ★★★★★ (5/5) in lab.\n");
  const notEvaluated = rating(null, {}, { na: { reason: "no-effect", detail: "no external effect in the baseline" } });
  assert.equal(fixSummary(outcome({ before: notEvaluated, candidates: [], chosen: null, patchPath: null })), "No fix attempted for naive: not evaluated (no-effect).\n");
});

test("an empty identity is named as such in the trade-off", () => {
  assert.match(fixSummary(outcome({ identity: [] })), /^Trade-off: a second legitimate call with the same identity \(no fields\) in the same turn is blocked\.$/m);
});

// ---------------------------------------------------------------- report

function report(commit: string | null, tools: ToolRating[], dirty = false): Report {
  return {
    schemaVersion: 1,
    engine: { name: "eve-crashtest", version: "0.1.0" },
    createdAt: "2026-12-02T10:30:00.000Z",
    target: { name: "zoo", commit, dirty },
    eve: { version: "1.5.0", capabilities: { replayNever: false } },
    lab: { platform: "linux", node: "24.2.0", cells: 30 },
    agent: { stars: 1, evaluated: tools.length, total: tools.length },
    tools,
  };
}

const CLEAN_APP = { commit: "abc1234", dirty: false };

test("a clean report made at the commit of a clean app supplies the ratings by tool", () => {
  const naive = rating(1, { "post-effect-fast-stable": "dup" });
  const readonly = rating(null, {}, { tool: "readonly" });
  const found = usableRatings(report("abc1234", [naive, readonly]), CLEAN_APP);
  assert.ok("ratings" in found, JSON.stringify(found));
  assert.deepEqual([...found.ratings.keys()], ["naive", "readonly"]);
  assert.equal(found.ratings.get("naive"), naive);
});

test("a report made at another commit, or without one, is not used", () => {
  const tools = [rating(1, {})];
  assert.deepEqual(usableRatings(report("abc1234", tools), { commit: "def5678", dirty: false }), { unusable: "it was made at commit abc1234 and the app is at def5678" });
  assert.deepEqual(usableRatings(report(null, tools), CLEAN_APP), { unusable: "it records no commit" });
  assert.deepEqual(usableRatings(report("abc1234", tools), { commit: null, dirty: false }), { unusable: "the app has no git commit to compare it with" });
});

test("a report made on uncommitted changes is not used", () => {
  assert.deepEqual(usableRatings(report("abc1234", [rating(1, {})], true), CLEAN_APP), { unusable: "it was made on uncommitted changes" });
});

test("a report is not used while the app has uncommitted changes", () => {
test("a report that does not say whether its tree was clean is not used", () => {
  const made = report("abc1234", [rating(1, {})]);
  const { dirty: _dirty, ...withoutDirty } = made.target;
  for (const target of [withoutDirty, { ...made.target, dirty: "false" }, { ...made.target, dirty: null }]) {
    const unclear = { ...made, target } as unknown as Report;
    assert.deepEqual(usableRatings(unclear, CLEAN_APP), { unusable: "it does not record whether it was made on uncommitted changes" }, JSON.stringify(target));
  }
});

  assert.deepEqual(usableRatings(report("abc1234", [rating(1, {})]), { commit: "abc1234", dirty: true }), { unusable: "the app has uncommitted changes now" });
});
