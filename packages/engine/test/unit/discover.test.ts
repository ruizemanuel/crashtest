import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { discover, SKIP_EXCLUDED, SKIP_NOT_LISTED } from "../../src/discover.ts";
import { EngineError } from "../../src/errors.ts";
import type { Lab } from "../../src/lab.ts";

/** A fake `eve` binary: it prints whatever the lab's `eve-info.stub` file contains, so no real eve runs. */
const STUB_EVE = `process.stdout.write(require("node:fs").readFileSync("eve-info.stub", "utf8"));
`;

const OVERLAID = "crashtest/crashtest-script";

function put(root: string, rel: string, content = ""): void {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function info(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ready",
    diagnostics: { errors: 0, warnings: 0 },
    model: OVERLAID,
    tools: ["bash", "read_file", "agent", "naive", "readonly"],
    toolInputSchemas: {
      root: {
        bash: { type: "object" },
        naive: { type: "object", properties: { to: { type: "string" } } },
        readonly: { type: "object", properties: { orderId: { type: "string" } } },
      },
    },
    ...overrides,
  };
}

/** A lab whose authored tools are `toolFiles` and whose `eve info` prints `stdout`. */
function setup(t: TestContext, stdout: string, toolFiles: string[], eveDts: Record<string, string> = {}): Lab {
  const root = mkdtempSync(join(tmpdir(), "ct-discover-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const labDir = join(root, "app", ".crashtest", "lab");
  put(join(root, "eve"), "package.json", JSON.stringify({ name: "eve", version: "1.5.0", bin: { eve: "bin/eve.js" } }));
  put(join(root, "eve"), "bin/eve.js", STUB_EVE);
  for (const [rel, content] of Object.entries(eveDts)) put(join(root, "eve", "dist"), rel, content);
  put(labDir, "eve-info.stub", stdout);
  for (const file of toolFiles) put(labDir, `agent/tools/${file}`, "export default {};\n");
  return { appDir: join(root, "app"), outDir: join(root, "app", ".crashtest"), labDir, eveBin: join(root, "eve", "bin", "eve.js"), eveVersion: "1.5.0" };
}

test("tools are the authored files that eve lists, sorted, with their schemas; the rest is skipped", async (t) => {
  const lab = setup(t, JSON.stringify(info()), ["readonly.ts", "naive.mts", "ghost.js", "naive.spec.ts", "readonly.test.ts", "notes.md", "data.json"]);
  put(lab.labDir, "agent/tools/nested/inner.ts", "export default {};\n");

  const discovery = await discover(lab, {});

  assert.deepEqual(discovery.tools.map((tool) => tool.name), ["naive", "readonly"]);
  assert.deepEqual(discovery.tools.map((tool) => tool.file), ["agent/tools/naive.mts", "agent/tools/readonly.ts"]);
  assert.deepEqual(discovery.tools[0]!.inputSchema, { type: "object", properties: { to: { type: "string" } } });
  assert.deepEqual(discovery.skipped, [{ name: "ghost", reason: SKIP_NOT_LISTED }]);
  assert.deepEqual(discovery.eve, { version: "1.5.0", capabilities: { replayNever: false } });
});

test("a file that only disables a framework tool is neither a tool nor skipped", async (t) => {
  // eve info no longer lists bash and read_file: the authored files are the switches that turned them off.
  const lab = setup(t, JSON.stringify(info({ tools: ["agent", "naive"] })), ["naive.ts", "ghost.ts"]);
  put(lab.labDir, "agent/tools/bash.ts", 'import { disableTool } from "eve/tools";\nexport default disableTool();\n');
  put(lab.labDir, "agent/tools/read_file.mjs", 'import { disableTool } from "eve/tools";\nexport default disableTool ( );\n');

  const discovery = await discover(lab, {});

  assert.deepEqual(discovery.tools.map((x) => x.name), ["naive"]);
  assert.deepEqual(discovery.skipped, [{ name: "ghost", reason: SKIP_NOT_LISTED }]);
});

test("a listed tool whose file mentions disableTool is still a tool", async (t) => {
  const lab = setup(t, JSON.stringify(info()), ["naive.ts"]);
  put(lab.labDir, "agent/tools/readonly.ts", 'import { disableTool } from "eve/tools";\n// disableTool() is for framework tools\nexport default {};\n');

  const discovery = await discover(lab, {});

  assert.deepEqual(discovery.tools.map((x) => x.name), ["naive", "readonly"]);
  assert.deepEqual(discovery.skipped, []);
});

test("a listed tool without a schema gets a null schema", async (t) => {
  const lab = setup(t, JSON.stringify(info({ toolInputSchemas: { root: {} } })), ["naive.ts"]);
  assert.deepEqual((await discover(lab, {})).tools, [{ name: "naive", file: "agent/tools/naive.ts", inputSchema: null }]);
});

test("config.tools.exclude removes tools from the run and reports them", async (t) => {
  const lab = setup(t, JSON.stringify(info()), ["naive.ts", "readonly.ts", "ghost.ts"]);

  const discovery = await discover(lab, { tools: { exclude: ["readonly", "ghost"] } });

  assert.deepEqual(discovery.tools.map((tool) => tool.name), ["naive"]);
  assert.deepEqual(discovery.skipped, [
    { name: "ghost", reason: SKIP_EXCLUDED },
    { name: "readonly", reason: SKIP_EXCLUDED },
  ]);
});

test("an app without agent/tools has no tools", async (t) => {
  const lab = setup(t, JSON.stringify(info()), []);
  assert.deepEqual(await discover(lab, {}), { tools: [], skipped: [], eve: { version: "1.5.0", capabilities: { replayNever: false } } });
});

test("lines around the JSON object are tolerated", async (t) => {
  const lab = setup(t, `(node:1) ExperimentalWarning: something\n${JSON.stringify(info(), null, 2)}\nDone.\n`, ["naive.ts"]);
  assert.deepEqual((await discover(lab, {})).tools.map((tool) => tool.name), ["naive"]);
});

test("a lab that eve cannot use is an error that names the problem and carries the output tail", async (t) => {
  const cases: { label: string; stdout: string; message: RegExp }[] = [
    { label: "not ready", stdout: JSON.stringify(info({ status: "error" })), message: /status is "error"/ },
    { label: "diagnostic errors", stdout: JSON.stringify(info({ diagnostics: { errors: 2, warnings: 0 } })), message: /report 2 errors/ },
    { label: "no diagnostics", stdout: JSON.stringify(info({ diagnostics: undefined })), message: /diagnostics are missing/ },
    { label: "overlay not applied", stdout: JSON.stringify(info({ model: "anthropic/claude-haiku-5.5" })), message: /overlay did not take effect/ },
    { label: "no JSON", stdout: "eve crashed: cannot read agent\n", message: /printed no JSON object/ },
    { label: "broken JSON", stdout: '{"status": "ready", ', message: /printed no JSON object/ },
  ];
  for (const { label, stdout, message } of cases) {
    const lab = setup(t, stdout, ["naive.ts"]);
    await assert.rejects(discover(lab, {}), (error: unknown) => {
      assert.ok(error instanceof EngineError, label);
      assert.match(error.message, message, label);
      assert.match(error.message, /output tail/, label);
      assert.ok(error.message.includes(stdout.trim().slice(-20)), `${label}: the tail shows eve's own output`);
      return true;
    });
  }
});

test("replayNever is true only when an eve type definition declares it", async (t) => {
  const declared = setup(t, JSON.stringify(info()), [], { "tools/types.d.ts": 'export interface ToolOptions { replay?: "never" }\n' });
  const unrelated = setup(t, JSON.stringify(info()), [], {
    "tools/types.d.ts": "export interface ToolOptions { retries?: number }\n",
    "tools/types.js": 'const x = { replay?: "never" };\n',
  });
  const noDist = setup(t, JSON.stringify(info()), []);

  assert.equal((await discover(declared, {})).eve.capabilities.replayNever, true);
  assert.equal((await discover(unrelated, {})).eve.capabilities.replayNever, false);
  assert.equal((await discover(noDist, {})).eve.capabilities.replayNever, false);
});

test("eve info runs with CLI telemetry disabled", async (t) => {
  // eve info would otherwise send telemetry (discovery runs without the preload) from a detached
  // process that keeps the lab as its working directory.
  const lab = setup(t, JSON.stringify(info()), ["naive.ts"]);
  writeFileSync(
    lab.eveBin,
    `const info = JSON.parse(require("node:fs").readFileSync("eve-info.stub", "utf8"));
if (process.env.EVE_TELEMETRY_DISABLED !== "1") info.status = "telemetry-enabled";
process.stdout.write(JSON.stringify(info));
`,
  );
  assert.deepEqual((await discover(lab, {})).tools.map((tool) => tool.name), ["naive"]);
});
