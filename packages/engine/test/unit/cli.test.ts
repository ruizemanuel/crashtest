import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../src/cli.ts";
import { captureStderr, captureStdout, type Capture } from "./capture.ts";

const active: Capture[] = [];

afterEach(() => {
  while (active.length > 0) active.pop()!.restore();
});

/** A fresh empty directory, removed after the test. */
function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * An `--app` that does not exist: if argument validation ever let a command through, it would stop at the
 * missing app (exit 1) instead of starting an audit of the current directory.
 */
function missingApp(t: TestContext): string {
  return join(tempDir(t), "no-such-app");
}

function stdout(): Capture {
  const c = captureStdout();
  active.push(c);
  return c;
}

function stderr(): Capture {
  const c = captureStderr();
  active.push(c);
  return c;
}

test("--version prints the package version", async () => {
  const out = stdout();
  assert.equal(await main(["--version"]), 0);
  assert.equal(out.text().trim(), "0.1.0");
});

test("unknown command exits 2 with usage on stderr", async () => {
  const err = stderr();
  assert.equal(await main(["nope"]), 2);
  assert.match(err.text(), /plan.*run.*lane.*fix.*badge/s);
});

test("--help and no arguments print usage on stdout and exit 0", async () => {
  for (const argv of [["--help"], []]) {
    const out = stdout();
    assert.equal(await main(argv), 0);
    assert.match(out.text(), /plan.*run.*lane.*fix.*badge/s);
    active.pop()!.restore();
  }
});

test("lane without --tool exits 2 and names the flag", async (t) => {
  const err = stderr();
  assert.equal(await main(["lane", "--app", missingApp(t)]), 2);
  assert.match(err.text(), /--tool/);
});

test("--min-stars must be an integer from 1 to 5", async (t) => {
  for (const value of ["9", "0", "2.5", "x", "-1"]) {
    const err = stderr();
    assert.equal(await main(["run", "--app", missingApp(t), "--min-stars", value]), 2, `--min-stars ${value}`);
    assert.match(err.text(), /--min-stars/);
    active.pop()!.restore();
  }
});

test("usage errors exit 2 with the problem on stderr", async (t) => {
  const app = missingApp(t);
  const cases: [string[], RegExp][] = [
    [["plan", "--app", app, "--nope"], /unknown option --nope/],
    [["plan", "--app"], /--app needs a value/],
    [["lane", "--app", app, "--tool", "--json"], /--tool needs a value/],
    [["lane", "--app", app, "--tool", "naive", "--tool", "readonly"], /--tool is given twice/],
    [["plan", "--app", app, "--json=yes"], /--json takes no value/],
    [["badge", "report.json"], /unexpected argument "report.json"/],
    [["run", "--app", app, "--tools", " , "], /--tools needs at least one tool name/],
    [["lane", "--app", app, "--tools", "naive"], /unknown option --tools/],
  ];
  for (const [argv, problem] of cases) {
    const out = stdout();
    const err = stderr();
    assert.equal(await main(argv), 2, argv.join(" "));
    assert.match(err.text(), problem, argv.join(" "));
    assert.equal(out.text(), "", `stdout stays empty for ${argv.join(" ")}`);
    active.pop()!.restore();
    active.pop()!.restore();
  }
});

test("--name=value is the same as --name value", async (t) => {
  const err = stderr();
  assert.equal(await main(["run", `--app=${missingApp(t)}`, "--min-stars=7"]), 2);
  assert.match(err.text(), /--min-stars must be an integer from 1 to 5, got "7"/);
});

test("--help after a command prints usage and exits 0", async () => {
  const out = stdout();
  assert.equal(await main(["run", "--help"]), 0);
  assert.match(out.text(), /--min-stars/);
});

test("a config error exits 1 with crashtest: and the message", async (t) => {
  const app = tempDir(t);
  const err = stderr();
  assert.equal(await main(["plan", "--app", app, "--config", join(app, "missing.json")]), 1);
  assert.match(err.text(), /^crashtest: .*missing\.json: file not found\n$/);
});

test("an app directory that does not exist exits 1", async (t) => {
  const app = missingApp(t);
  const err = stderr();
  assert.equal(await main(["plan", "--app", app]), 1);
  assert.match(err.text(), /^crashtest: the app directory .*no-such-app does not exist\n$/);
});

test("badge exits 1 when the report is missing or is not a report", async (t) => {
  const dir = tempDir(t);
  const notReport = join(dir, "other.json");
  writeFileSync(notReport, JSON.stringify({ schemaVersion: 2 }));
  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{");
  const cases: [string, RegExp][] = [
    [join(dir, "none.json"), /^crashtest: cannot read the report .*none\.json: file not found\n$/],
    [notReport, /^crashtest: .*other\.json is not a crashtest report \(schemaVersion 1\)\n$/],
    [broken, /^crashtest: .*broken\.json is not valid JSON/],
  ];
  for (const [file, problem] of cases) {
    const err = stderr();
    assert.equal(await main(["badge", "--report", file]), 1, file);
    assert.match(err.text(), problem);
    active.pop()!.restore();
  }
});

test("fix needs exactly one of --tool and --all, and --identity only with --tool", async (t) => {
  const app = missingApp(t);
  const cases: [string[], RegExp][] = [
    [["fix", "--app", app], /fix needs --tool <name> or --all/],
    [["fix", "--app", app, "--tool", "naive", "--all"], /fix takes --tool <name> or --all, not both/],
    [["fix", "--app", app, "--all", "--identity", "to"], /--identity names the fields of one tool: use it with --tool/],
    [["fix", "--app", app, "--tool", "naive", "--identity", " , "], /--identity needs at least one field name/],
    [["fix", "--app", app, "--all=yes"], /--all takes no value/],
    [["fix", "--app", app, "--tools", "naive"], /unknown option --tools/],
  ];
  for (const [argv, problem] of cases) {
    const out = stdout();
    const err = stderr();
    assert.equal(await main(argv), 2, argv.join(" "));
    assert.match(err.text(), problem, argv.join(" "));
    assert.equal(out.text(), "", `stdout stays empty for ${argv.join(" ")}`);
    active.pop()!.restore();
    active.pop()!.restore();
  }
});

/** A report of `tools` made at `commit`, written to a temporary file. */
function reportFile(t: TestContext, commit: string, tools: unknown[]): string {
  const file = join(tempDir(t), "report.json");
  const report = {
    schemaVersion: 1,
    engine: { name: "eve-crashtest", version: "0.1.0" },
    createdAt: "2026-12-02T10:30:00.000Z",
    target: { name: "zoo", commit, dirty: false },
    eve: { version: "1.5.0", capabilities: { replayNever: false } },
    lab: { platform: "linux", node: "24.2.0", cells: 6 },
    agent: { stars: 5, evaluated: 1, total: 1 },
    tools,
  };
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

const FIVE_STAR_NAIVE = {
  tool: "naive",
  stars: 5,
  approval: false,
  benignRepeats: false,
  identity: ["to", "orderId"],
  summary: "",
  recommendation: "",
  cells: [{ cellId: "post-effect-fast-stable", kind: "clean" }],
};

test("fix takes the rating from a report made at the app's commit", async (t) => {
  const zoo = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "zoo");
  const head = spawnSync("git", ["-C", zoo, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return t.skip("the zoo is not in a git work tree");
  const out = stdout();
  const err = stderr();
  assert.equal(await main(["fix", "--tool", "naive", "--app", zoo, "--report", reportFile(t, head.stdout.trim(), [FIVE_STAR_NAIVE])]), 0, err.text());
  assert.equal(out.text(), "No fix needed for naive: ★★★★★ (5/5) in lab.\n");
  assert.doesNotMatch(err.text(), /ignored/);
});

test("fix ignores a report made at another commit, with one line on stderr", async (t) => {
  const app = missingApp(t);
  const file = reportFile(t, "0000000", [FIVE_STAR_NAIVE]);
  const err = stderr();
  assert.equal(await main(["fix", "--tool", "naive", "--app", app, "--report", file]), 1);
  const lines = err.text().split("\n").filter(Boolean);
  assert.equal(lines.length, 2, err.text());
  assert.match(lines[0]!, /^\[crashtest\] the report .*report\.json is ignored: the app has no git commit to compare it with$/);
  assert.match(lines[1]!, /^crashtest: the app directory .*no-such-app does not exist$/, "the fresh lane is attempted instead");
});

test("fix exits 1 when the report has no usable tool ratings", async (t) => {
  const file = reportFile(t, "0000000", [{ tool: "naive", stars: 9 }]);
  const err = stderr();
  assert.equal(await main(["fix", "--tool", "naive", "--app", missingApp(t), "--report", file]), 1);
  assert.match(err.text(), /^crashtest: .*report\.json has a tool rating crashtest cannot read: naive\n$/);
});
