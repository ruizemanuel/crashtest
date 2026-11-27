import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { newTypeErrors, readModuleSettings } from "../../src/fix/typecheck.ts";

const TSCONFIG = `{"compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","moduleResolution":"bundler"},"include":["agent/**/*.ts"]}`;
const TOOL = "interface Input { text: string }\nexport const f = (input: Input) => input.text;\n";

function tempApp(t: TestContext, files: Record<string, string>, tsconfig: string | null = TSCONFIG): string {
  const app = mkdtempSync(join(tmpdir(), "ct-typecheck-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(tsconfig === null ? files : { "tsconfig.json": tsconfig, ...files })) {
    const file = join(app, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return app;
}

test("an edit that adds a type error is reported with its file and message", (t) => {
  const root = tempApp(t, { "agent/tools/t.ts": TOOL });
  const edited = TOOL.replace("input.text", "input.orderId");

  const errors = newTypeErrors(root, [{ path: "agent/tools/t.ts", text: edited }]);

  assert.equal(errors?.length, 1);
  assert.match(errors![0]!, /^agent\/tools\/t\.ts: .*orderId/);
});

test("errors the project already had are not new", (t) => {
  const broken = `${TOOL}export const n: number = "x";\n`;
  const root = tempApp(t, { "agent/tools/t.ts": broken, "agent/tools/other.ts": `export const m: string = 1;\n` });

  assert.deepEqual(newTypeErrors(root, [{ path: "agent/tools/t.ts", text: `${broken}export const g = 1;\n` }]), []);
  // The same error once more is new: errors are counted, not just compared.
  assert.equal(newTypeErrors(root, [{ path: "agent/tools/t.ts", text: `${broken}export const k: number = "y";\n` }])?.length, 1);
});

test("missing modules and type packages never count", (t) => {
  const root = tempApp(t, { "agent/tools/t.ts": TOOL });
  const edited = `import { x } from "nope";\n${TOOL}export const a = process.env.A;\n`;

  assert.deepEqual(newTypeErrors(root, [{ path: "agent/tools/t.ts", text: edited }]), []);
});

test("a new file in the edits is checked too", (t) => {
  const root = tempApp(t, { "agent/tools/t.ts": TOOL });

  const errors = newTypeErrors(root, [{ path: "agent/lib/h.ts", text: `export const n: number = "x";\n` }]);

  assert.equal(errors?.length, 1);
  assert.match(errors![0]!, /^agent\/lib\/h\.ts: /);
});

test("a new file in the edits is what the edited files import from it", (t) => {
  // The new file is in a directory that does not exist yet; an import of it must still resolve, or every name
  // taken from it would quietly become `any`.
  const root = tempApp(t, { "agent/tools/t.ts": TOOL });
  const edits = [
    { path: "agent/tools/t.ts", text: `import { n } from "../lib/h";\n${TOOL}export const s: string = n;\n` },
    { path: "agent/lib/h.ts", text: `export const n: number = 1;\n` },
  ];

  const errors = newTypeErrors(root, edits);

  assert.equal(errors?.length, 1);
  assert.match(errors![0]!, /^agent\/tools\/t\.ts: Type 'number' is not assignable to type 'string'/);
});

test("the errors of the first edit come first, also when another file sorts before it", (t) => {
  const root = tempApp(t, { "agent/tools/t.ts": TOOL });
  const edits = [
    { path: "agent/tools/t.ts", text: TOOL.replace("input.text", "input.orderId") },
    { path: "agent/lib/h.ts", text: `export const n: number = "x";\n` },
  ];

  const errors = newTypeErrors(root, edits);

  assert.equal(errors?.length, 2);
  assert.match(errors![0]!, /^agent\/tools\/t\.ts: .*orderId/);
  assert.match(errors![1]!, /^agent\/lib\/h\.ts: /);
});

test("an app without tsconfig.json is not checked", (t) => {
  const rootWithoutTsconfig = tempApp(t, { "agent/tools/t.ts": TOOL }, null);
  const edits = [{ path: "agent/tools/t.ts", text: TOOL.replace("input.text", "input.orderId") }];

  assert.equal(newTypeErrors(rootWithoutTsconfig, edits), null);
});

test("a tsconfig.json the compiler cannot read throws its first error instead of being checked", (t) => {
  const edits = [{ path: "agent/tools/t.ts", text: TOOL }];
  const malformed = tempApp(t, { "agent/tools/t.ts": TOOL }, `{"compilerOptions":{"strict":true},"include":["agent/**/*.ts"`);
  const missingBase = tempApp(t, { "agent/tools/t.ts": TOOL }, `{"extends":"../../tsconfig.base.json","include":["agent/**/*.ts"]}`);

  for (const root of [malformed, missingBase]) {
    assert.throws(() => newTypeErrors(root, edits), /^Error: tsconfig\.json: /);
    assert.throws(() => readModuleSettings(root), /^Error: tsconfig\.json: /);
  }
  assert.throws(() => readModuleSettings(missingBase), /tsconfig\.base\.json/);
});

test("a tsconfig.json that includes none of the app's files still checks the edited ones", (t) => {
  const root = tempApp(t, { "agent/tools/t.ts": TOOL }, `{"compilerOptions":{"strict":true,"noEmit":true},"include":["agents/**/*.ts"]}`);

  const errors = newTypeErrors(root, [{ path: "agent/tools/t.ts", text: TOOL.replace("input.text", "input.orderId") }]);

  assert.equal(errors?.length, 1);
  assert.match(errors![0]!, /^agent\/tools\/t\.ts: .*orderId/);
});

test("Node's module settings need the extension, however they are spelled", (t) => {
  const settings = (compilerOptions: string): ReturnType<typeof readModuleSettings> =>
    readModuleSettings(tempApp(t, {}, `{"compilerOptions":${compilerOptions},"include":["agent/**/*.ts"]}`));

  assert.deepEqual(settings(`{"module":"node20"}`), { nodeEsm: true, tsExtensions: false });
  assert.deepEqual(settings(`{"module":"Node18"}`), { nodeEsm: true, tsExtensions: false });
  assert.deepEqual(settings(`{"module":"node16"}`), { nodeEsm: true, tsExtensions: false });
  assert.deepEqual(settings(`{"moduleResolution":"NodeNext"}`), { nodeEsm: true, tsExtensions: false });
  assert.deepEqual(settings(`{"module":"NodeNext","allowImportingTsExtensions":true}`), { nodeEsm: true, tsExtensions: true });
  assert.deepEqual(settings(`{"module":"esnext","moduleResolution":"bundler"}`), { nodeEsm: false, tsExtensions: false });
});
