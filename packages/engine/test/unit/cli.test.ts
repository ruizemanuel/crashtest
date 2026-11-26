import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, type TestContext } from "node:test";
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
