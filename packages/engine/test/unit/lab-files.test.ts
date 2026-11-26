import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { restoreLabFiles, writtenPaths } from "../../src/driver/lab-files.ts";
import type { Lab } from "../../src/lab.ts";

/** An app and a lab next to each other in a temp directory; `outside` is somewhere no restore may ever touch. */
function setup(t: TestContext): { lab: Lab; app: string; labDir: string; outside: string } {
  const root = mkdtempSync(join(tmpdir(), "ct-lab-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app");
  const labDir = join(root, "app", ".crashtest", "lab");
  const outside = join(root, "outside");
  for (const dir of [app, labDir, outside]) mkdirSync(dir, { recursive: true });
  return { lab: { appDir: app, outDir: join(app, ".crashtest"), labDir, eveBin: "eve", eveVersion: "1.5.0" }, app, labDir, outside };
}

function put(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("a file the app has is copied back over what the tool wrote", (t) => {
  const { lab, app, labDir } = setup(t);
  put(join(app, "data", "state.json"), '{"prepared":true}');
  put(join(labDir, "data", "state.json"), '{"prepared":true}');
  writeFileSync(join(labDir, "data", "state.json"), '{"written":"by the tool"}');
  assert.deepEqual(restoreLabFiles(lab, ["data/state.json"]), []);
  assert.equal(readFileSync(join(labDir, "data", "state.json"), "utf8"), '{"prepared":true}');
});

test("a file the app does not have is removed, with the empty directories the tool made for it", (t) => {
  const { lab, app, labDir } = setup(t);
  put(join(app, "agent", "agent.ts"), "prepared");
  put(join(labDir, "agent", "agent.ts"), "prepared");
  put(join(labDir, "agent", "scratch", "note.txt"), "x");
  put(join(labDir, "data", "deep", "outbox.jsonl"), "x\n");
  put(join(labDir, "data", "other.txt"), "kept: the tool did not write it through node:fs");
  assert.deepEqual(restoreLabFiles(lab, ["agent/scratch/note.txt", "data/deep/outbox.jsonl", "gone/already.txt"]), []);
  assert.equal(existsSync(join(labDir, "agent", "scratch")), false);
  assert.equal(existsSync(join(labDir, "data", "deep")), false);
  // A directory that still holds a file is kept, and so is a prepared one.
  assert.equal(readFileSync(join(labDir, "data", "other.txt"), "utf8").length > 0, true);
  assert.equal(readFileSync(join(labDir, "agent", "agent.ts"), "utf8"), "prepared");
});

test("a path that leaves the lab is refused and nothing outside is touched", (t) => {
  const { lab, labDir, outside } = setup(t);
  const sentinel = join(outside, "sentinel.txt");
  put(sentinel, "keep");
  put(join(labDir, "..", "next-to-lab.txt"), "keep");
  const refused = ["../../../outside/sentinel.txt", "data/../../next-to-lab.txt", "data/../inside-the-lab.txt", sentinel, "/etc/hosts", "", "a\0b"];
  const problems = restoreLabFiles(lab, refused);
  assert.equal(problems.length, refused.length, problems.join("\n"));
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
  assert.equal(readFileSync(join(labDir, "..", "next-to-lab.txt"), "utf8"), "keep");
});

test("a link inside the lab that leads out of it is not followed", (t) => {
  const { lab, labDir, outside } = setup(t);
  const sentinel = join(outside, "sentinel.txt");
  put(sentinel, "keep");
  symlinkSync(outside, join(labDir, "escape"), "junction");
  const problems = restoreLabFiles(lab, ["escape/sentinel.txt"]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0] ?? "", /leaves the lab/);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("secret files and excluded directories are never copied in from the app", (t) => {
  const { lab, app, labDir } = setup(t);
  put(join(app, ".env"), "TOKEN=secret");
  put(join(app, "config", ".env.local"), "TOKEN=secret");
  put(join(labDir, ".env"), "written by the tool");
  put(join(labDir, "config", ".env.local"), "written by the tool");
  assert.deepEqual(restoreLabFiles(lab, [".env", "config/.env.local"]), []);
  assert.equal(existsSync(join(labDir, ".env")), false);
  assert.equal(existsSync(join(labDir, "config", ".env.local")), false);
});

test("a path that is a directory in the lab is reported, not deleted", (t) => {
  const { lab, labDir } = setup(t);
  put(join(labDir, "data", "inner.txt"), "x");
  const problems = restoreLabFiles(lab, ["data"]);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.equal(existsSync(join(labDir, "data", "inner.txt")), true);
});

test("the paths to restore are the file effects of the ledger, once each", () => {
  const line = (entry: object): string => JSON.stringify(entry);
  const ledger = [
    line({ kind: "http", url: "https://api.acme.test/v1/messages" }),
    line({ kind: "fs", url: "data/outbox.jsonl" }),
    "not json",
    line({ kind: "fs", url: "data/outbox.jsonl" }),
    line({ kind: "fs", url: "data/state.json" }),
    line({ kind: "fs" }),
    "",
  ].join("\n");
  assert.deepEqual(writtenPaths(ledger), ["data/outbox.jsonl", "data/state.json"]);
  assert.deepEqual(writtenPaths(""), []);
});
