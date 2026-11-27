import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FixOutcome, Strategy } from "../../src/fix/fix.ts";
import type { Report, Stars } from "../../src/types.ts";
import { cli, hashTree } from "./helpers.ts";

// The demo contract of the reference agent `examples/acme-support`: `crashtest run` rates it 1 star, `crashtest fix
// --all --apply` patches every tool rated below 5 stars, and a second `run` rates every evaluated tool 5 stars. It
// works on a copy inside the example's `.crashtest/`, which git ignores: the report then records the repository's
// commit with a clean tree, so `fix` takes its before ratings from it, and the example itself stays unprotected.
// 18 lanes (about 115 runs, each a full `eve dev` life): about 25 minutes on one machine. The CLI runs as a child
// process (see `cli`).
const E2E = { timeout: 3_600_000 };
const here = dirname(fileURLToPath(import.meta.url));
const acmeDir = join(here, "..", "..", "..", "..", "examples", "acme-support");
const copyDir = join(acmeDir, ".crashtest", "e2e-copy");
const outDir = join(copyDir, ".crashtest");
const reportFile = join(outDir, "report.json");
/** Never copied: the copy finds the example's `node_modules` upward, and earlier output would land in it. */
const NOT_COPIED = new Set([".crashtest", "node_modules"]);

const BEFORE: Record<string, Stars | null> = {
  refund_payment: 1,
  post_slack_update: 2,
  send_email: 3,
  upload_receipt: 4,
  add_ticket_label: 5,
  lookup_order: null,
};
const CHOSEN: Record<string, Strategy> = {
  refund_payment: "upstream-key",
  post_slack_update: "ledger-guard",
  send_email: "ledger-guard",
  upload_receipt: "ledger-guard",
};
const AFTER: Record<string, Stars | null> = { ...BEFORE, refund_payment: 5, post_slack_update: 5, send_email: 5, upload_receipt: 5 };

/** A fresh copy of the example's own files at `copyDir`. */
function freshCopy(): void {
  rmSync(copyDir, { recursive: true, force: true, maxRetries: 3 });
  const copied = (path: string): boolean => !relative(acmeDir, path).split(sep).some((segment) => NOT_COPIED.has(segment));
  for (const entry of readdirSync(acmeDir)) {
    if (!NOT_COPIED.has(entry)) cpSync(join(acmeDir, entry), join(copyDir, entry), { recursive: true, filter: copied });
  }
}

function readReport(): Report {
  return JSON.parse(readFileSync(reportFile, "utf8")) as Report;
}

function readOutcome(tool: string): FixOutcome {
  return JSON.parse(readFileSync(join(outDir, "fix", `${tool}.json`), "utf8")) as FixOutcome;
}

function starsByTool(report: Report): Record<string, Stars | null> {
  return Object.fromEntries(report.tools.map((rating) => [rating.tool, rating.stars]));
}

/** One line per tool with its verdicts, for assertion messages. */
function detail(report: Report): string {
  return report.tools
    .map((rating) => {
      const cells = rating.cells.map((cell) => `${cell.cellId}=${cell.kind}${cell.dupClass ? `(${cell.dupClass})` : ""}/${cell.outcome}`);
      return `${rating.tool}: ${rating.stars ?? `N/E (${rating.na?.reason})`} ${cells.join(" ")}`;
    })
    .join("\n");
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)} s`;
}

test("acme: 1 star to 5 stars", E2E, async (t) => {
  const source = hashTree(acmeDir, [...NOT_COPIED, ".eve"]);
  freshCopy();

  // Before: every rating case of the table, and the agent at the lowest of them.
  let t0 = Date.now();
  const first = await cli(t, ["run", "--app", copyDir]);
  assert.equal(first.code, 0, first.stderr);
  const before = readReport();
  t.diagnostic(`run before: ${before.lab.cells} runs, ${seconds(t0)}\n${detail(before)}`);
  assert.deepEqual(starsByTool(before), BEFORE, detail(before));
  assert.equal(before.tools.find((rating) => rating.tool === "lookup_order")?.na?.reason, "no-effect", detail(before));
  assert.deepEqual(before.agent, { stars: 1, evaluated: 5, total: 6 });
  assert.ok(before.target.commit !== null && !before.target.dirty, `the copy reads as a clean commit: ${JSON.stringify(before.target)}`);

  // Fix: one candidate lane per codemod that applies, the chosen patch applied to the copy before the next tool.
  t0 = Date.now();
  const fix = await cli(t, ["fix", "--all", "--apply", "--app", copyDir, "--report", reportFile]);
  assert.equal(fix.code, 0, fix.stderr);
  t.diagnostic(`fix: ${seconds(t0)}\n${fix.stdout}`);
  assert.doesNotMatch(fix.stderr, /is ignored/, "fix takes the before ratings from the report");
  for (const [tool, strategy] of Object.entries(CHOSEN)) {
    const outcome = readOutcome(tool);
    const candidates = outcome.candidates.map((c) => {
      if (c.after === undefined) return `${c.strategy}: ${c.reason ?? "no lane"}`;
      return `${c.strategy}: ${c.after.stars ?? `N/E (${c.after.na?.reason})`} stars, ${c.runs ?? 0} runs, ${((c.wallMs ?? 0) / 1000).toFixed(1)} s`;
    });
    const summary = `${tool} (identity ${outcome.identity.join(", ")}): ${candidates.join("; ")}`;
    t.diagnostic(summary);
    assert.equal(outcome.before.stars, BEFORE[tool], summary);
    assert.equal(outcome.chosen?.strategy, strategy, summary);
    assert.equal(outcome.chosen?.after?.stars, 5, summary);
  }
  // A key the provider honors is not enough for send_email: the rewritten text reuses it with a different body.
  const emailUpstream = readOutcome("send_email").candidates.find((candidate) => candidate.strategy === "upstream-key");
  assert.equal(emailUpstream?.after?.stars, 4, JSON.stringify(emailUpstream?.after?.cells));
  assert.match(fix.stdout, /^No fix needed for add_ticket_label: /m);
  assert.match(fix.stdout, /^No fix attempted for lookup_order: not evaluated/m);
  assert.equal(fix.stdout.match(/^Applied: /gm)?.length, Object.keys(CHOSEN).length, fix.stdout);
  for (const tool of ["add_ticket_label", "lookup_order"]) assert.ok(!existsSync(join(outDir, "fix", `${tool}.json`)), `${tool} gets no candidates`);

  // After: the patched copy.
  t0 = Date.now();
  const second = await cli(t, ["run", "--app", copyDir]);
  assert.equal(second.code, 0, second.stderr);
  const after = readReport();
  t.diagnostic(`run after: ${after.lab.cells} runs, ${seconds(t0)}\n${detail(after)}`);
  assert.deepEqual(starsByTool(after), AFTER, detail(after));
  assert.deepEqual(after.agent, { stars: 5, evaluated: 5, total: 6 });
  assert.match(readFileSync(join(outDir, "badge.svg"), "utf8"), /★★★★★/);
  assert.match(second.stdout, /^Agent rating: ★★★★★ \(5\/5\) · 5 of 6 tools evaluated · /m);

  assert.equal(hashTree(acmeDir, [...NOT_COPIED, ".eve"]), source, "the example itself is unchanged");
});
