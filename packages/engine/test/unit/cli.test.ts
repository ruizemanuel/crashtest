import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { main } from "../../src/cli.ts";
import { captureStderr, captureStdout, type Capture } from "./capture.ts";

const active: Capture[] = [];

afterEach(() => {
  while (active.length > 0) active.pop()!.restore();
});

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
