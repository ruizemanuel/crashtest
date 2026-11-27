import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SKIP_EXCLUDED, SKIP_NOT_LISTED } from "../../src/discover.ts";
import { engineVersion } from "../../src/paths.ts";
import { rateTool } from "../../src/rate.ts";
import { buildReport, type GitFacts } from "../../src/report/build.ts";
import { renderBadge } from "../../src/report/badge.ts";
import { renderMarkdown } from "../../src/report/markdown.ts";
import type { CellVerdict, EveFacts, LaneResult, Report, ToolRating } from "../../src/types.ts";
import { REFUNDS, verdict } from "./builders.ts";

const EVE: EveFacts = { version: "1.5.0", capabilities: { replayNever: true } };
const NOW = new Date("2026-12-02T10:30:00.000Z");
const GIT: GitFacts = { commit: "abc1234", dirty: false };
const BANNED = /\b(verified|safe)\b/i;
const ids = ["orderId", "amount"];

function dup(dupClass: "stable" | "fresh", cellId: CellVerdict["cellId"]): CellVerdict {
  return verdict({ cellId, kind: "dup", dupClass, stateChanges: 2, evidence: [{ endpoint: REFUNDS, count: 2, expected: 1, diffFields: [] }] });
}

const clean = [verdict({ cellId: "post-effect-fast-fresh" }), verdict({ cellId: "post-settle" })];

/** A lane for `tool` rated from `cells`; every lane ran five cells. */
function lane(tool: string, cells: CellVerdict[], extra: Partial<Parameters<typeof rateTool>[0]> = {}): LaneResult {
  return { tool, rating: rateTool({ tool, approval: false, cells, identity: ids, ...extra }), runs: 5, wallMs: 1000 };
}

/** One tool of every star level plus one that could not be evaluated: 30 cells in all. */
function everyLevel(): LaneResult[] {
  return [
    lane("refund", [dup("stable", "post-effect-fast-stable"), ...clean]),
    lane("charge", [dup("stable", "post-effect-fast-stable"), ...clean], { approval: true }),
    lane("notify", [verdict(), dup("fresh", "post-effect-fast-fresh"), verdict({ cellId: "post-settle" })]),
    lane("upload", [verdict(), verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error: "Blob already exists" }), verdict({ cellId: "post-settle" })]),
    lane("lookup", [verdict({ cellId: "baseline-1", recovery: "none" }), ...clean]),
    lane("ping", [], { na: { reason: "no-effect", detail: "" } }),
  ];
}

const MISSING = [
  { name: "ghost", reason: SKIP_NOT_LISTED },
  { name: "off", reason: SKIP_EXCLUDED },
];

function report(lanes: LaneResult[] = everyLevel(), skipped = MISSING, git = GIT): Report {
  return buildReport({ appDir: tmpdir(), eve: EVE, lanes, skipped, now: NOW, git });
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`### ${heading}`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const next = markdown.indexOf("\n### ", start + 1);
  const details = markdown.indexOf("\n<details>", start + 1);
  const ends = [next, details].filter((i) => i !== -1);
  return markdown.slice(start, ends.length === 0 ? undefined : Math.min(...ends));
}

// --- buildReport ----------------------------------------------------------------------------------------------

test("the report is versioned and carries the engine, target, eve and lab facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-report-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "shop-agent" }));
    const r = buildReport({ appDir: dir, eve: EVE, lanes: everyLevel(), skipped: MISSING, now: NOW, git: { commit: "abc1234", dirty: true } });
    assert.equal(r.schemaVersion, 1);
    assert.deepEqual(r.engine, { name: "eve-crashtest", version: engineVersion });
    assert.equal(r.createdAt, "2026-12-02T10:30:00.000Z");
    assert.deepEqual(r.target, { name: "shop-agent", commit: "abc1234", dirty: true });
    assert.deepEqual(r.eve, EVE);
    assert.equal(r.lab.cells, 30);
    assert.equal(r.lab.platform, process.platform);
    assert.equal(r.lab.node, process.versions.node);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the target name is the package name, else the directory name", () => {
  const dir = mkdtempSync(join(tmpdir(), "ct-name-"));
  try {
    const nameOf = () => buildReport({ appDir: dir, eve: EVE, lanes: [], skipped: [], now: NOW, git: GIT }).target.name;
    const base = dir.split(/[\\/]/).pop();
    assert.equal(nameOf(), base); // no package.json
    writeFileSync(join(dir, "package.json"), "{ not json");
    assert.equal(nameOf(), base); // unreadable package.json
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
    assert.equal(nameOf(), base); // no name
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "  " }));
    assert.equal(nameOf(), base); // blank name
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@acme/support-agent" }));
    assert.equal(nameOf(), "@acme/support-agent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tools eve did not list become not-evaluated ratings; tools excluded by config are left out entirely", () => {
  const r = report();
  const ghost = r.tools.find((t) => t.tool === "ghost");
  assert.ok(ghost);
  assert.equal(ghost.stars, null);
  assert.deepEqual(ghost.na, { reason: "not-discovered", detail: SKIP_NOT_LISTED });
  assert.equal(ghost.summary, "eve did not list this tool.");
  assert.deepEqual(ghost.cells, []);
  assert.equal(r.tools.some((t) => t.tool === "off"), false);
  assert.deepEqual(r.tools.map((t) => t.tool), ["refund", "charge", "notify", "upload", "lookup", "ping", "ghost"]);
  assert.equal(r.lab.cells, 30, "skipped tools add no cells");
  assert.deepEqual(r.agent, { stars: 1, evaluated: 5, total: 7 });
});

test("the agent rating is the lowest rated tool; waived tools do not count", () => {
  const waived = lane("refund", [dup("stable", "post-effect-fast-stable"), ...clean], { waiver: "handled upstream" });
  const r = report([waived, lane("lookup", clean)], []);
  assert.deepEqual(r.agent, { stars: 5, evaluated: 1, total: 2 });
  assert.equal(report([], []).agent.stars, null);
});

/** Runs git in `cwd` as a throwaway identity, so a test can commit without touching any configured one. */
function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}

/** A repository with one commit holding `apps/shop` (the app) and `apps/other` (a sibling), both with a tracked file. */
function monorepo(dir: string): { repo: string; app: string; sibling: string } {
  const repo = join(dir, "mono");
  const app = join(repo, "apps", "shop");
  const sibling = join(repo, "apps", "other");
  mkdirSync(app, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(app, "package.json"), '{ "name": "shop" }\n');
  writeFileSync(join(sibling, "notes.txt"), "one\n");
  assert.equal(git(repo, "init", "-q").status, 0);
  assert.equal(git(repo, "add", ".").status, 0);
  assert.equal(git(repo, "commit", "-q", "-m", "first").status, 0);
  return { repo, app, sibling };
}

const isDirty = (appDir: string, outDir?: string): boolean =>
  buildReport({ appDir, eve: EVE, lanes: [], skipped: [], now: NOW, ...(outDir === undefined ? {} : { outDir }) }).target.dirty;

test("the dirty flag ignores the engine's own output and anything outside the app", (t) => {
  if (git(tmpdir(), "--version").status !== 0) return t.skip("git is not installed");
  const dir = mkdtempSync(join(tmpdir(), "ct-dirty-"));
  try {
    const { app, sibling } = monorepo(dir);
    assert.equal(isDirty(app), false, "a clean checkout is clean");

    // What a run leaves behind: the output directory's own .gitignore (which does not ignore itself) and the reports.
    mkdirSync(join(app, ".crashtest", "fix"), { recursive: true });
    writeFileSync(join(app, ".crashtest", ".gitignore"), "lab/\nlab-*/\nruns/\n");
    writeFileSync(join(app, ".crashtest", "report.json"), "{}\n");
    writeFileSync(join(app, ".crashtest", "fix", "refund.patch"), "\n");
    assert.match(git(app, "status", "--porcelain").stdout, /\?\? .*\.crashtest\//, "git itself sees the output directory as untracked");
    assert.equal(isDirty(app), false, "the default output directory does not count");

    writeFileSync(join(sibling, "notes.txt"), "two\n");
    assert.equal(isDirty(app), false, "a change in a sibling directory is not a change to the app");

    rmSync(join(app, ".crashtest"), { recursive: true });
    mkdirSync(join(app, "out"));
    writeFileSync(join(app, "out", "report.json"), "{}\n");
    assert.equal(isDirty(app), true, "an untracked directory the engine does not own counts");
    assert.equal(isDirty(app, join(app, "out")), false, "unless it is the configured output directory");
    assert.equal(isDirty(app, join(dir, "elsewhere")), true, "an output directory outside the app excludes nothing");
    rmSync(join(app, "out"), { recursive: true });

    writeFileSync(join(app, "package.json"), '{ "name": "shop", "private": true }\n');
    assert.equal(isDirty(app), true, "a modified tracked file inside the app is dirty");
    assert.equal(isDirty(app, join(app, "out")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new file inside the app makes it dirty", (t) => {
  if (git(tmpdir(), "--version").status !== 0) return t.skip("git is not installed");
  const dir = mkdtempSync(join(tmpdir(), "ct-dirty-"));
  try {
    const { app } = monorepo(dir);
    mkdirSync(join(app, "agent"));
    writeFileSync(join(app, "agent", "new-tool.ts"), "export default {};\n");
    assert.equal(isDirty(app), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a git status that fails reads as dirty, never as clean", (t) => {
  if (git(tmpdir(), "--version").status !== 0) return t.skip("git is not installed");
  const dir = mkdtempSync(join(tmpdir(), "ct-git-"));
  try {
    const { app } = monorepo(dir);
    assert.equal(isDirty(app), false);
    // A damaged index: HEAD still resolves, but `git status` fails.
    writeFileSync(join(dir, "mono", ".git", "index"), "not an index");
    assert.notEqual(git(app, "status", "--porcelain").status, 0, "the precondition: git status fails");
    const report = buildReport({ appDir: app, eve: EVE, lanes: [], skipped: [], now: NOW });
    assert.match(report.target.commit ?? "", /^[0-9a-f]{7}$/);
    assert.equal(report.target.dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git facts come from the app directory, and are empty outside a repository", (t) => {
  if (git(tmpdir(), "--version").status !== 0) return t.skip("git is not installed");

  const dir = mkdtempSync(join(tmpdir(), "ct-git-"));
  try {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    // Stop git from finding a repository above the temp directory.
    const before = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      const outside = buildReport({ appDir: plain, eve: EVE, lanes: [], skipped: [], now: NOW });
      assert.equal(outside.target.commit, null);
      assert.equal(outside.target.dirty, false);
    } finally {
      if (before === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = before;
    }

    const repo = join(dir, "repo");
    mkdirSync(repo);
    assert.equal(git(repo, "init", "-q").status, 0);
    const empty = buildReport({ appDir: repo, eve: EVE, lanes: [], skipped: [], now: NOW });
    assert.deepEqual([empty.target.commit, empty.target.dirty], [null, false], "a repository without a commit has no commit");

    writeFileSync(join(repo, "a.txt"), "one");
    assert.equal(git(repo, "add", ".").status, 0);
    assert.equal(git(repo, "commit", "-q", "-m", "first").status, 0);
    const head = git(repo, "rev-parse", "HEAD").stdout.trim();
    const cleanTree = buildReport({ appDir: repo, eve: EVE, lanes: [], skipped: [], now: NOW });
    assert.equal(cleanTree.target.commit, head.slice(0, 7));
    assert.equal(cleanTree.target.dirty, false);

    writeFileSync(join(repo, "a.txt"), "two");
    const dirty = buildReport({ appDir: repo, eve: EVE, lanes: [], skipped: [], now: NOW });
    assert.equal(dirty.target.commit, head.slice(0, 7));
    assert.equal(dirty.target.dirty, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Markdown -------------------------------------------------------------------------------------------------

test("the Markdown opens with the title and the lab line", () => {
  const md = renderMarkdown(report());
  const lines = md.split("\n");
  assert.equal(lines[0], "## Crashtest report");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "In lab: 30 cells · eve 1.5.0 · commit abc1234 · 2026-12-02");
  assert.equal(lines[3], "");
  assert.equal(lines[4], "**Agent rating: ★☆☆☆☆ (1/5)** · 5 of 7 tools evaluated");
  assert.ok(md.endsWith("\n") && !md.endsWith("\n\n"));
});

test("what holds up comes before the findings, the findings run worst first, and not-evaluated tools come last", () => {
  const md = renderMarkdown(report());
  const order = ["### What already holds up", "### Findings", "### Not evaluated", "<details><summary>Evidence</summary>"].map((h) => md.indexOf(h));
  assert.ok(order.every((i) => i !== -1), "every section is present");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections are in the constructive order");

  assert.equal(
    section(md, "What already holds up"),
    "### What already holds up\n\n- `lookup` ★★★★★ — One state change in every cell, and the model always got a truthful result.\n",
  );

  const findings = section(md, "Findings");
  const rows = findings.split("\n").filter((line) => line.startsWith("| `"));
  assert.deepEqual(rows.map((row) => row.split("|")[1]?.trim()), ["`refund`", "`charge`", "`notify`", "`upload`"]);
  assert.deepEqual(rows.map((row) => row.split("|")[2]?.trim()), ["★☆☆☆☆", "★★☆☆☆", "★★★☆☆", "★★★★☆"]);
  assert.ok(findings.includes("| Tool | Rating | What happened | Recommendation |\n| --- | --- | --- | --- |\n"));
  assert.ok(!findings.includes("`lookup`"), "5-star tools are not findings");

  assert.equal(
    section(md, "Not evaluated"),
    "### Not evaluated\n\n- `ghost` — eve did not list this tool.\n- `ping` — No external effect observed in the baseline.\n",
  );
});

test("a finding row carries the tool's summary and recommendation", () => {
  const md = renderMarkdown(report());
  const row = section(md, "Findings").split("\n").find((line) => line.startsWith("| `refund`"));
  assert.equal(
    row,
    "| `refund` | ★☆☆☆☆ | Ran twice after a crash replayed the step with the same call id (2 effects, expected 1). | " +
      "Send an idempotency key built from business identity fields (`orderId`, `amount`), not `ctx.callId`. " +
      "The provider supports a lookup, so the tool can also check whether the effect already happened before acting. |",
  );
});

test("findings with the same stars are ordered by tool name", () => {
  const dups = (tool: string) => lane(tool, [verdict(), dup("fresh", "post-effect-fast-fresh"), verdict({ cellId: "post-settle" })]);
  const md = renderMarkdown(report([dups("zeta"), dups("alpha"), dups("mid")], []));
  const rows = section(md, "Findings").split("\n").filter((line) => line.startsWith("| `"));
  assert.deepEqual(rows.map((row) => row.split("|")[1]?.trim()), ["`alpha`", "`mid`", "`zeta`"]);
});

test("the evidence table lists every cell of every evaluated tool", () => {
  const md = renderMarkdown(report());
  const details = md.slice(md.indexOf("<details>"), md.indexOf("</details>") + "</details>".length);
  assert.ok(details.startsWith("<details><summary>Evidence</summary>\n\n"));
  assert.ok(details.endsWith("\n\n</details>"));
  assert.ok(details.includes("**`refund`**\n\n| Cell | Verdict | Effects | Recovery | Runs |\n| --- | --- | --- | --- | --- |\n"));
  assert.ok(details.includes("| post-effect-fast (stable id) | dup | 2/1 | replayed | 1 |"));
  assert.ok(details.includes("| post-settle (2.5 s latency) | clean | 1/1 | replayed | 1 |"));
  assert.ok(details.includes("| baseline 1 | clean | 1/1 | none | 1 |"), "a tool's baseline appears under its own label");
  assert.ok(details.includes("**`charge`**") && details.includes("| approved-post-effect | dup | 2/1 | replayed | 1 |"), "approval tools use the approved label");
  assert.ok(!details.includes("**`ghost`**") && !details.includes("**`ping`**"), "tools without cells have no table");
});

test("a verdict that was confirmed on some runs says how many", () => {
  const seen = lane("refund", [verdict({ cellId: "post-effect-fast-stable", kind: "dup", dupClass: "stable", stateChanges: 2, seen: "2 of 3", attempts: 3, evidence: [{ endpoint: REFUNDS, count: 2, expected: 1, diffFields: [] }] }), ...clean]);
  const md = renderMarkdown(report([seen], []));
  assert.ok(md.includes("| post-effect-fast (stable id) | dup (seen 2 of 3) | 2/1 | replayed | 3 |"));
});

test("the footer states the protection mechanisms and the limits", () => {
  const yes = renderMarkdown(report());
  assert.ok(yes.includes('Protection mechanisms in eve 1.5.0: `replay: "never"` available.\n'));
  const no = renderMarkdown({ ...report(), eve: { version: "1.4.0", capabilities: { replayNever: false } } });
  assert.ok(no.includes('Protection mechanisms in eve 1.4.0: `replay: "never"` not available.\n'));
  assert.ok(
    yes.endsWith(
      "Limits: crashtest observes HTTP/1.1 requests made through fetch/http/https and node:fs writes inside the app. Other traffic (raw TCP, HTTP/2, gRPC, database and queue drivers, SMTP) and effects inside eve sandboxes are neither observed nor blocked: non-HTTP connections reach their real servers.\n",
    ),
  );
});

test("the commit reads as the sha, sha+dirty or no commit", () => {
  assert.ok(renderMarkdown(report(everyLevel(), MISSING, { commit: "abc1234", dirty: true })).includes("commit abc1234+dirty · 2026-12-02"));
  assert.ok(renderMarkdown(report(everyLevel(), MISSING, { commit: null, dirty: false })).includes("commit no commit · 2026-12-02"));
});

test("a report with no rated tool says not evaluated and has no findings", () => {
  const md = renderMarkdown(report([lane("ping", [], { na: { reason: "no-effect", detail: "" } })], []));
  assert.equal(md.split("\n")[4], "**Agent rating: not evaluated**");
  assert.ok(!md.includes("### Findings") && !md.includes("### What already holds up"), "empty sections are left out");
  assert.ok(md.includes("### Not evaluated"));
  assert.ok(!md.includes("<details>"), "no cells, no evidence");
});

test("a waived tool keeps its stars and shows the waiver", () => {
  const waivedFinding = lane("refund", [dup("stable", "post-effect-fast-stable"), ...clean], { waiver: "handled upstream" });
  const waivedClean = lane("lookup", clean, { waiver: "reviewed by hand" });
  const md = renderMarkdown(report([waivedFinding, waivedClean], []));
  assert.ok(md.includes("| `refund` | ★☆☆☆☆ (waived: handled upstream) |"));
  assert.ok(md.includes("- `lookup` ★★★★★ (waived: reviewed by hand) — "));
  assert.equal(md.split("\n")[4], "**Agent rating: not evaluated**", "waived tools do not count toward the agent rating");
});

test("text that would break a table is escaped", () => {
  const rating: ToolRating = { ...lane("refund", clean).rating, stars: 3, summary: "a | b\nsecond line", recommendation: "use `x | y`" };
  const md = renderMarkdown(report([{ tool: "refund", rating, runs: 5, wallMs: 1 }], []));
  const row = section(md, "Findings").split("\n").find((line) => line.startsWith("| `refund`"));
  assert.equal(row, "| `refund` | ★★★☆☆ | a \\| b second line | use `x \\| y` |");
});

test("tool names cannot break a code span, a table row or a list item", () => {
  const md = renderMarkdown(
    report(
      [
        lane("a`b|c", [dup("stable", "post-effect-fast-stable"), ...clean]),
        lane("`edge`", clean),
        lane("two\nlines", [], { na: { reason: "no-effect", detail: "" } }),
      ],
      [],
    ),
  );
  assert.ok(md.includes("| ``a`b\\|c`` | ★☆☆☆☆ |"), "a backtick lengthens the fence and a pipe is escaped in a table");
  assert.ok(md.includes("- `` `edge` `` ★★★★★ — "), "a name that starts or ends with a backtick is padded");
  assert.ok(md.includes("- `two lines` — No external effect observed in the baseline."), "a line break becomes a space");
  assert.ok(md.includes("**``a`b|c``**\n\n| Cell"), "the evidence heading uses the same code span, without the table escape");
  const row = section(md, "Findings").split("\n").find((l) => l.startsWith("| ``a"));
  assert.equal(row?.split(/(?<!\\)\|/).length, 6, "the row still has four cells");
});

test("text from tools and config cannot ping anyone or inject HTML into a posted comment", () => {
  const hostile = "@octocat <img src=x onerror=alert(1)>";
  const phantom = verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error: hostile });
  const rated = lane("refund", [verdict(), phantom], { waiver: "ask @octocat" });
  const hand: ToolRating = { ...lane("notify", clean).rating, stars: 3, summary: hostile, recommendation: `${hostile} (cc @hubot)` };
  const failed = lane("ping", [], { na: { reason: "baseline-failed", detail: hostile } });
  const md = renderMarkdown(report([rated, { tool: "notify", rating: hand, runs: 5, wallMs: 1 }, failed], []));

  assert.ok(!md.includes("@octocat") && !md.includes("@hubot"), "every @ is followed by a zero-width space");
  assert.ok(!md.includes("<img"), "no raw HTML from outside text");
  assert.ok(md.includes("the model got an error: @\u200boctocat &lt;img src=x onerror=alert(1)> |"), "the error is quoted, neutralized, in the table");
  assert.ok(md.includes("| `notify` | ★★★☆☆ | @\u200boctocat &lt;img src=x onerror=alert(1)> | @\u200boctocat &lt;img src=x onerror=alert(1)> (cc @\u200bhubot) |"));
  assert.ok(md.includes("(cc @\u200bhubot)"));
  assert.ok(md.includes("(waived: ask @\u200boctocat)"));
  assert.ok(md.includes("- `ping` — The baseline run failed: @\u200boctocat &lt;img src=x onerror=alert(1)>"), "also in the not-evaluated list");
  assert.ok(md.includes("<details><summary>Evidence</summary>"), "the report's own markup is untouched");
});

test("a report with no tools at all renders", () => {
  const r = report([], []);
  assert.deepEqual(r.tools, []);
  assert.deepEqual(r.agent, { stars: null, evaluated: 0, total: 0 });
  const md = renderMarkdown(r);
  assert.equal(md.split("\n")[2], "In lab: 0 cells · eve 1.5.0 · commit abc1234 · 2026-12-02");
  assert.equal(md.split("\n")[4], "**Agent rating: not evaluated**");
  assert.ok(!md.includes("###") && !md.includes("<details>"));
  assert.ok(md.includes("Protection mechanisms in eve 1.5.0:") && md.includes("Limits: crashtest observes"));
  assert.ok(renderBadge(r).includes("not evaluated"));
});

test("the Markdown never calls anything verified or safe, at any star level", () => {
  const all = everyLevel();
  for (const lanes of [all, ...all.map((l) => [l]), []]) {
    const md = renderMarkdown(report(lanes));
    assert.doesNotMatch(md, BANNED);
  }
});

// --- badge ----------------------------------------------------------------------------------------------------

test("the badge of a 4-star report", () => {
  const r = report([lane("lookup", clean), lane("upload", [verdict(), verdict({ cellId: "post-effect-fast-fresh", kind: "phantom-failure", outcome: "error", error: "x" }), verdict({ cellId: "post-settle" })])], []);
  assert.equal(r.agent.stars, 4);
  const svg = renderBadge(r);
  const label = "crashtest: 4/5 stars · eve 1.5.0 · commit abc1234 · 2026-12-02 · in lab, 10 cells";
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('role="img"'));
  assert.ok(svg.includes(`aria-label="${label}"`));
  assert.ok(svg.includes(`<title>${label}</title>`));
  assert.ok(svg.includes("★★★★☆ eve 1.5.0"));
  assert.ok(svg.includes("#97ca00"));
  assert.ok(svg.includes("#555"));
  assert.ok(svg.includes('height="20"'));
  assert.ok(svg.includes("Verdana") && svg.includes('font-size="11"'));
  assert.doesNotMatch(svg, BANNED);
});

test("the badge segments are 12 + 7 x characters wide", () => {
  const svg = renderBadge(report([lane("lookup", clean)], [])); // "★★★★★ eve 1.5.0" is 15 characters
  const left = 12 + 7 * "crashtest".length;
  const right = 12 + 7 * "★★★★★ eve 1.5.0".length;
  assert.ok(svg.includes(`width="${left + right}"`));
  assert.ok(svg.includes(`<rect width="${left}" height="20" fill="#555"/>`));
  assert.ok(svg.includes(`<rect x="${left}" width="${right}" height="20" fill="#2ea44f"/>`));
});

test("the badge colour follows the stars", () => {
  const colours: Record<number, string> = { 5: "#2ea44f", 4: "#97ca00", 3: "#dfb317", 2: "#fe7d37", 1: "#e05d44" };
  const base = report();
  for (const [stars, colour] of Object.entries(colours)) {
    const svg = renderBadge({ ...base, agent: { ...base.agent, stars: Number(stars) as 1 } });
    assert.ok(svg.includes(`fill="${colour}"`), `${stars} stars is ${colour}`);
    assert.ok(svg.includes(`crashtest: ${stars}/5 stars`));
    assert.doesNotMatch(svg, BANNED);
  }
});

test("the badge of a report that could not be evaluated", () => {
  const svg = renderBadge(report([lane("ping", [], { na: { reason: "no-effect", detail: "" } })], [], { commit: null, dirty: false }));
  assert.ok(svg.includes(">not evaluated<"));
  assert.ok(svg.includes("#9f9f9f"));
  assert.ok(svg.includes('aria-label="crashtest: not evaluated · eve 1.5.0 · commit no commit · 2026-12-02 · in lab, 5 cells"'));
  assert.ok(svg.includes(`<rect x="75" width="${12 + 7 * "not evaluated".length}" height="20" fill="#9f9f9f"/>`));
  assert.doesNotMatch(svg, BANNED);
});

test("the badge escapes text that would break the markup", () => {
  const svg = renderBadge({ ...report(), eve: { ...EVE, version: `1.5.0"><&` } });
  assert.ok(svg.includes("eve 1.5.0&quot;&gt;&lt;&amp;"));
  assert.ok(!svg.includes(`1.5.0"><&`));
  const dirty = renderBadge(report(everyLevel(), MISSING, { commit: "abc1234", dirty: true }));
  assert.ok(dirty.includes("commit abc1234+dirty"));
});
