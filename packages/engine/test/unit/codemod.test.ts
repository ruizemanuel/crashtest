import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { Project } from "ts-morph";
import { applyLedgerGuard, applyUpstreamKey, type CodemodResult } from "../../src/fix/codemod.ts";
import { templatePath } from "../../src/paths.ts";
import type { ToolInfo } from "../../src/types.ts";

const HELPER = "agent/lib/crashtest-idempotency.ts";
const HELPER_TEXT = readFileSync(templatePath("idempotency.ts"), "utf8");
const IDENTITY = ["to", "orderId"];

const NOTIFY = `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Send an order notification to a customer.",
  inputSchema: z.object({ to: z.string(), orderId: z.string(), text: z.string() }),
  async execute(input, ctx) {
    const response = await fetch("https://api.acme-notify.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ ...input, turnId: ctx.session.turn.id }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
`;

const NOTIFY_GUARDED = `import { defineTool } from "eve/tools";
import { z } from "zod";
import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";

export default defineTool({
  description: "Send an order notification to a customer.",
  inputSchema: z.object({ to: z.string(), orderId: z.string(), text: z.string() }),
  async execute(input, ctx) {
    return once(opKey(ctx, { to: input.to, orderId: input.orderId }), defaultStore(), async () => {
      const response = await fetch("https://api.acme-notify.test/v1/messages", {
        method: "POST",
        body: JSON.stringify({ ...input, turnId: ctx.session.turn.id }),
      });
      return (await response.json()) as Record<string, unknown>;
    });
  },
});
`;

const RESEND = `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Email an order confirmation.",
  inputSchema: z.object({ to: z.string(), orderId: z.string(), text: z.string() }),
  async execute(input, ctx) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": ctx.callId },
      body: JSON.stringify({ from: "shop@acme.test", to: input.to, subject: \`Order \${input.orderId}\`, text: input.text }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
`;

const RESEND_KEYED = `import { defineTool } from "eve/tools";
import { z } from "zod";
import { opKey } from "../lib/crashtest-idempotency";

export default defineTool({
  description: "Email an order confirmation.",
  inputSchema: z.object({ to: z.string(), orderId: z.string(), text: z.string() }),
  async execute(input, ctx) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": opKey(ctx, { to: input.to, orderId: input.orderId }) },
      body: JSON.stringify({ from: "shop@acme.test", to: input.to, subject: \`Order \${input.orderId}\`, text: input.text }),
    });
    return (await response.json()) as Record<string, unknown>;
  },
});
`;

/** A tool file around an `execute` member, so each test states only the part it cares about. */
function toolSource(execute: string, imports = ""): string {
  return `import { defineTool } from "eve/tools";
import { z } from "zod";
${imports}
export default defineTool({
  description: "Send an order notification to a customer.",
  inputSchema: z.object({ to: z.string(), orderId: z.string(), text: z.string() }),
${execute}
});
`;
}

/** `orderId` is a parameter, and a block around the fetch declares another `orderId`. */
const SHADOWED_ORDER_ID = toolSource(`  async execute({ to, orderId }, ctx) {
    if (to) {
      const orderId = "other";
      await fetch("https://api.stripe.com/v1/refunds", { method: "POST", body: orderId });
    }
    return { done: true };
  },`);

function tempApp(t: TestContext, files: Record<string, string>): string {
  const app = mkdtempSync(join(tmpdir(), "ct-codemod-"));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) put(app, rel, content);
  return app;
}

function put(app: string, rel: string, content: string): void {
  const file = join(app, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function read(app: string, rel: string): string {
  return readFileSync(join(app, ...rel.split("/")), "utf8");
}

function tool(name: string): ToolInfo {
  return { name, file: `agent/tools/${name}.ts`, inputSchema: null };
}

function syntaxErrors(text: string): string[] {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile("/tool.ts", text);
  return project.getProgram().getSyntacticDiagnostics().map((d) => JSON.stringify(d.getMessageText()));
}

/** Checks an applied result against the disk and returns the new text of the tool file. */
function appliedText(app: string, result: CodemodResult, rel: string, before: string): string {
  assert.equal(result.applied, true, result.reason);
  assert.equal(result.reason, undefined);
  const entry = result.files.find((f) => f.path === rel);
  assert.ok(entry, `${rel} is not in the result`);
  assert.equal(entry.before, before);
  assert.equal(entry.after, read(app, rel));
  assert.deepEqual(syntaxErrors(entry.after), []);
  return entry.after;
}

test("ledger-guard wraps a method's body in once() keyed on the identity fields of an input parameter", (t) => {
  const app = tempApp(t, { "agent/tools/notify.ts": NOTIFY });

  const result = applyLedgerGuard(app, tool("notify"), IDENTITY);

  const after = appliedText(app, result, "agent/tools/notify.ts", NOTIFY);
  assert.ok(after.includes("return once(opKey(ctx, { to: input.to, orderId: input.orderId }), defaultStore(), async () => {"));
  assert.equal(after, NOTIFY_GUARDED);
  assert.deepEqual(result.files, [
    { path: "agent/tools/notify.ts", before: NOTIFY, after: NOTIFY_GUARDED },
    { path: HELPER, before: null, after: HELPER_TEXT },
  ]);
  assert.equal(read(app, HELPER), HELPER_TEXT);
});

test("ledger-guard extends a destructured input and adds the context parameter of an arrow function", (t) => {
  const source = toolSource(`  execute: async ({ to, text }) => {
    await fetch("https://api.acme-notify.test/v1/messages", { method: "POST", body: JSON.stringify({ to, text }) });
    return { sent: true };
  },`);
  const app = tempApp(t, { "agent/tools/notify.ts": source });

  const result = applyLedgerGuard(app, tool("notify"), IDENTITY);

  assert.equal(
    appliedText(app, result, "agent/tools/notify.ts", source),
    toolSource(
      `  execute: async ({ to, text, orderId }, ctx) => {
    return once(opKey(ctx, { to, orderId }), defaultStore(), async () => {
      await fetch("https://api.acme-notify.test/v1/messages", { method: "POST", body: JSON.stringify({ to, text }) });
      return { sent: true };
    });
  },`,
      `import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";\n`,
    ),
  );
});

test("ledger-guard wraps an expression body and keeps multi-line template literals as they are", (t) => {
  const arrow = toolSource(`  execute: async (input, ctx) => fetch("https://api.acme-notify.test/v1/messages", { method: "POST" }),`);
  const method = toolSource(`  async execute(input) {
    const text = \`Order \${input.orderId}
shipped\`;
    return { text };
  },`);
  const app = tempApp(t, { "agent/tools/arrow.ts": arrow, "agent/tools/method.ts": method });
  const imports = `import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";\n`;

  assert.equal(
    appliedText(app, applyLedgerGuard(app, tool("arrow"), ["orderId"]), "agent/tools/arrow.ts", arrow),
    toolSource(
      `  execute: async (input, ctx) => once(opKey(ctx, { orderId: input.orderId }), defaultStore(), async () => (fetch("https://api.acme-notify.test/v1/messages", { method: "POST" }))),`,
      imports,
    ),
  );
  assert.equal(
    appliedText(app, applyLedgerGuard(app, tool("method"), ["orderId"]), "agent/tools/method.ts", method),
    toolSource(
      `  async execute(input, ctx) {
    return once(opKey(ctx, { orderId: input.orderId }), defaultStore(), async () => {
      const text = \`Order \${input.orderId}
shipped\`;
      return { text };
    });
  },`,
      imports,
    ),
  );
});

test("ledger-guard keeps the meaning of a destructured input it extends", (t) => {
  // A name the body already uses gets an alias, and a field a rest element collects is read from it.
  const shadowed = toolSource(`  async execute({ to }, ctx) {
    const orderId = "local";
    return { to, orderId };
  },`);
  const rest = toolSource(`  async execute({ to, ...rest }, ctx) {
    return { to, rest };
  },`);
  const app = tempApp(t, { "agent/tools/shadowed.ts": shadowed, "agent/tools/rest.ts": rest });
  const imports = `import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";\n`;

  assert.equal(
    appliedText(app, applyLedgerGuard(app, tool("shadowed"), IDENTITY), "agent/tools/shadowed.ts", shadowed),
    toolSource(
      `  async execute({ to, orderId: orderId2 }, ctx) {
    return once(opKey(ctx, { to, orderId: orderId2 }), defaultStore(), async () => {
      const orderId = "local";
      return { to, orderId };
    });
  },`,
      imports,
    ),
  );
  assert.equal(
    appliedText(app, applyLedgerGuard(app, tool("rest"), IDENTITY), "agent/tools/rest.ts", rest),
    toolSource(
      `  async execute({ to, ...rest }, ctx) {
    return once(opKey(ctx, { to, orderId: rest.orderId }), defaultStore(), async () => {
      return { to, rest };
    });
  },`,
      imports,
    ),
  );
});

test("ledger-guard follows the .ts extension style, the line endings and the byte order mark of the file", (t) => {
  const withExtension = NOTIFY.replace(`import { z } from "zod";\n`, `import { z } from "zod";\nimport { audit } from "../lib/audit.ts";\n`);
  const bom = String.fromCharCode(0xfeff);
  const windows = `${bom}${NOTIFY.replaceAll("\n", "\r\n")}`;
  const app = tempApp(t, { "agent/tools/ext.ts": withExtension, "agent/tools/windows.ts": windows });

  const ext = appliedText(app, applyLedgerGuard(app, tool("ext"), IDENTITY), "agent/tools/ext.ts", withExtension);
  assert.ok(ext.includes(`import { audit } from "../lib/audit.ts";\nimport { defaultStore, once, opKey } from "../lib/crashtest-idempotency.ts";\n`));

  const result = applyLedgerGuard(app, tool("windows"), IDENTITY);
  assert.equal(appliedText(app, result, "agent/tools/windows.ts", windows), `${bom}${NOTIFY_GUARDED.replaceAll("\n", "\r\n")}`);
});

test("ledger-guard applied a second time reports that the tool is already guarded and writes nothing", (t) => {
  const app = tempApp(t, { "agent/tools/notify.ts": NOTIFY });
  applyLedgerGuard(app, tool("notify"), IDENTITY);

  const again = applyLedgerGuard(app, tool("notify"), IDENTITY);

  assert.deepEqual(again, { applied: false, reason: "already guarded", files: [] });
  assert.equal(read(app, "agent/tools/notify.ts"), NOTIFY_GUARDED);
});

test("the helper file is created once and never overwritten", (t) => {
  const app = tempApp(t, { "agent/tools/a.ts": NOTIFY, "agent/tools/b.ts": RESEND });

  const first = applyLedgerGuard(app, tool("a"), IDENTITY);
  const second = applyUpstreamKey(app, tool("b"), IDENTITY);

  assert.deepEqual(
    first.files.map((f) => [f.path, f.before]),
    [
      ["agent/tools/a.ts", NOTIFY],
      [HELPER, null],
    ],
  );
  assert.deepEqual(
    second.files.map((f) => f.path),
    ["agent/tools/b.ts"],
  );
  assert.equal(read(app, HELPER), HELPER_TEXT);

  const edited = `${HELPER_TEXT}// edited by the user\n`;
  const own = tempApp(t, { "agent/tools/a.ts": NOTIFY, [HELPER]: edited });
  const result = applyLedgerGuard(own, tool("a"), IDENTITY);
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["agent/tools/a.ts"],
  );
  assert.equal(read(own, HELPER), edited);
});

test("upstream-key replaces an Idempotency-Key tied to ctx.callId with an op-key on a Resend fetch", (t) => {
  const app = tempApp(t, { "agent/tools/email.ts": RESEND });

  const result = applyUpstreamKey(app, tool("email"), IDENTITY);

  assert.equal(appliedText(app, result, "agent/tools/email.ts", RESEND), RESEND_KEYED);
  assert.deepEqual(
    result.files.map((f) => [f.path, f.before]),
    [
      ["agent/tools/email.ts", RESEND],
      [HELPER, null],
    ],
  );
});

test("upstream-key replaces an Idempotency-Key written as a computed string name", (t) => {
  const source = RESEND.replace(`"Idempotency-Key": ctx.callId`, `["idempotency-key"]: ctx.callId`);
  const app = tempApp(t, { "agent/tools/email.ts": source });

  const result = applyUpstreamKey(app, tool("email"), IDENTITY);

  assert.equal(appliedText(app, result, "agent/tools/email.ts", source), RESEND_KEYED);
});

test("ledger-guard reads the parameters even when the body declares an identity name again", (t) => {
  // Its key sits at the top of the body, and the original statements move into the function once runs.
  const app = tempApp(t, { "agent/tools/refund.ts": SHADOWED_ORDER_ID });

  const result = applyLedgerGuard(app, tool("refund"), IDENTITY);

  assert.equal(
    appliedText(app, result, "agent/tools/refund.ts", SHADOWED_ORDER_ID),
    toolSource(
      `  async execute({ to, orderId }, ctx) {
    return once(opKey(ctx, { to, orderId }), defaultStore(), async () => {
      if (to) {
        const orderId = "other";
        await fetch("https://api.stripe.com/v1/refunds", { method: "POST", body: orderId });
      }
      return { done: true };
    });
  },`,
      `import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";\n`,
    ),
  );
});

/** A tool whose `execute` makes `call` and a fetch to a host without idempotency keys. */
function stripeTool(call: string): string {
  return toolSource(`  async execute({ to, orderId }, ctx) {
    ${call}
    await fetch("https://api.acme-notify.test/v1/messages", { method: "POST" });
    return { done: true };
  },`);
}

test("upstream-key adds the header, the headers or the init a Stripe fetch is missing", (t) => {
  const key = "opKey(ctx, { to, orderId })";
  const cases: Record<string, [before: string, after: string]> = {
    init: [
      `await fetch(\`https://api.stripe.com/v1/refunds\`, { method: "POST" });`,
      `await fetch(\`https://api.stripe.com/v1/refunds\`, { method: "POST", headers: { "Idempotency-Key": ${key} } });`,
    ],
    bare: [
      `await fetch("https://api.stripe.com/v1/customers");`,
      `await fetch("https://api.stripe.com/v1/customers", { headers: { "Idempotency-Key": ${key} } });`,
    ],
    replaced: [
      `await fetch(\`https://api.stripe.com/v1/charges/\${orderId}/capture\`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "idempotency-key": to,
      },
    });`,
      `await fetch(\`https://api.stripe.com/v1/charges/\${orderId}/capture\`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "Idempotency-Key": ${key},
      },
    });`,
    ],
    appended: [
      `await fetch("https://api.stripe.com/v1/payouts", {
      headers: {
        accept: "application/json",
      },
    });`,
      `await fetch("https://api.stripe.com/v1/payouts", {
      headers: {
        accept: "application/json",
        "Idempotency-Key": ${key},
      },
    });`,
    ],
  };
  const app = tempApp(t, Object.fromEntries(Object.entries(cases).map(([name, [before]]) => [`agent/tools/${name}.ts`, stripeTool(before)])));

  for (const [name, [before, after]] of Object.entries(cases)) {
    const rel = `agent/tools/${name}.ts`;
    assert.equal(
      appliedText(app, applyUpstreamKey(app, tool(name), IDENTITY), rel, stripeTool(before)),
      stripeTool(after).replace(`import { z } from "zod";\n`, `import { z } from "zod";\nimport { opKey } from "../lib/crashtest-idempotency";\n`),
      name,
    );
  }
});

test("upstream-key keys a single fetch inside if and try blocks", (t) => {
  const execute = (headers: string): string => `  async execute(input, ctx) {
    try {
      if (input.to !== "") {
        const response = await fetch("https://api.resend.com/emails", { method: "POST"${headers} });
        return (await response.json()) as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  },`;
  const source = toolSource(execute(""));
  const app = tempApp(t, { "agent/tools/email.ts": source });

  const result = applyUpstreamKey(app, tool("email"), IDENTITY);

  assert.equal(
    appliedText(app, result, "agent/tools/email.ts", source),
    toolSource(
      execute(`, headers: { "Idempotency-Key": opKey(ctx, { to: input.to, orderId: input.orderId }) }`),
      `import { opKey } from "../lib/crashtest-idempotency";\n`,
    ),
  );
});

test("upstream-key keys a fetch inside the function that ledger-guard hands to once", (t) => {
  // That function runs at most once per op-key, so the key is never reused with another body.
  const app = tempApp(t, { "agent/tools/email.ts": RESEND });
  const guarded = applyLedgerGuard(app, tool("email"), IDENTITY).files[0]!.after;

  const result = applyUpstreamKey(app, tool("email"), IDENTITY);

  assert.equal(
    appliedText(app, result, "agent/tools/email.ts", guarded),
    guarded.replace(`"Idempotency-Key": ctx.callId`, `"Idempotency-Key": opKey(ctx, { to: input.to, orderId: input.orderId })`),
  );
});

test("upstream-key then ledger-guard share one helper import", (t) => {
  const app = tempApp(t, { "agent/tools/email.ts": RESEND });

  applyUpstreamKey(app, tool("email"), IDENTITY);
  const result = applyLedgerGuard(app, tool("email"), IDENTITY);

  const after = appliedText(app, result, "agent/tools/email.ts", RESEND_KEYED);
  assert.ok(after.includes(`import { opKey, defaultStore, once } from "../lib/crashtest-idempotency";\n\n`));
  assert.equal(after.match(/crashtest-idempotency/g)?.length, 1);
  assert.deepEqual(applyUpstreamKey(app, tool("email"), IDENTITY), { applied: false, reason: "already guarded", files: [] });
});

const NOT_APPLIED: { name: string; source: string; codemod: typeof applyLedgerGuard; reason: string }[] = [
  {
    name: "a fetch to a host without idempotency keys",
    source: NOTIFY,
    codemod: applyUpstreamKey,
    reason: "no fetch call to an idempotency-capable host",
  },
  {
    name: "headers that are not an object literal",
    source: RESEND.replace(`headers: { "content-type": "application/json", "Idempotency-Key": ctx.callId },`, "headers: new Headers(),"),
    codemod: applyUpstreamKey,
    reason: "a fetch call to api.resend.com passes headers that are not an object literal",
  },
  {
    name: "headers that spread another object",
    source: RESEND.replace(`"Idempotency-Key": ctx.callId`, "...base"),
    codemod: applyUpstreamKey,
    reason: "a fetch call to api.resend.com spreads its headers, so an Idempotency-Key among them is unknown",
  },
  {
    name: "a header name computed from a variable",
    source: RESEND.replace(`"Idempotency-Key": ctx.callId`, "[KEY_HEADER]: ctx.callId"),
    codemod: applyUpstreamKey,
    reason: "a fetch call to api.resend.com has a computed header name",
  },
  {
    name: "an identity binding declared again in a block around the fetch",
    source: SHADOWED_ORDER_ID,
    codemod: applyUpstreamKey,
    reason: `"orderId" is declared again inside execute, so the key at the fetch call could read another value`,
  },
  {
    name: "a context shadowed by a catch clause around the fetch",
    source: toolSource(`  async execute(input, ctx) {
    try {
      return { done: await Promise.resolve(input.to) };
    } catch (ctx) {
      await fetch("https://api.resend.com/emails", { method: "POST", body: String(ctx) });
      return { done: false };
    }
  },`),
    codemod: applyUpstreamKey,
    reason: `"ctx" is declared again inside execute, so the key at the fetch call could read another value`,
  },
  {
    name: "two fetch calls to idempotency-capable hosts",
    source: toolSource(`  async execute(input, ctx) {
    await fetch("https://api.stripe.com/v1/refunds", { method: "POST" });
    await fetch("https://api.resend.com/emails", { method: "POST" });
    return { done: true };
  },`),
    codemod: applyUpstreamKey,
    reason: "several fetch calls to idempotency-capable hosts share one identity",
  },
  {
    name: "a fetch to an idempotency-capable host in a for-of loop",
    source: toolSource(`  async execute(input, ctx) {
    for (const to of input.to.split(",")) {
      await fetch("https://api.resend.com/emails", { method: "POST", body: JSON.stringify({ to }) });
    }
    return { done: true };
  },`),
    codemod: applyUpstreamKey,
    reason: "fetch call to an idempotency-capable host inside a loop or callback",
  },
  {
    name: "a fetch to an idempotency-capable host in a map callback",
    source: toolSource(`  async execute(input, ctx) {
    const to = input.to.split(",");
    await Promise.all(to.map(async (address) => fetch("https://api.resend.com/emails", { method: "POST", body: address })));
    return { done: true };
  },`),
    codemod: applyUpstreamKey,
    reason: "fetch call to an idempotency-capable host inside a loop or callback",
  },
  {
    name: "a destructured context",
    source: toolSource(`  async execute(input, { session }) {\n    return { session };\n  },`),
    codemod: applyLedgerGuard,
    reason: "execute destructures its context",
  },
  {
    name: "a name imported from elsewhere",
    source: toolSource(`  async execute(input, ctx) {\n    return { ok: true };\n  },`, `import { once } from "node:events";\n`),
    codemod: applyLedgerGuard,
    reason: `"once" is already imported from "node:events"`,
  },
  {
    name: "a name declared in the file",
    source: `${RESEND}function opKey(): string {\n  return "mine";\n}\n`,
    codemod: applyUpstreamKey,
    reason: `"opKey" is already declared in the tool file`,
  },
  {
    name: "a default export that is not a defineTool call",
    source: `export default { description: "Not a tool." };\n`,
    codemod: applyLedgerGuard,
    reason: "the default export is not a defineTool({...}) call",
  },
  {
    name: "a defineTool call without execute",
    source: `import { defineTool } from "eve/tools";\nexport default defineTool({ description: "No execute." });\n`,
    codemod: applyLedgerGuard,
    reason: "defineTool({...}) has no execute member",
  },
  {
    name: "a generator execute",
    source: toolSource(`  async *execute(input, ctx) {\n    yield { ok: true };\n  },`),
    codemod: applyLedgerGuard,
    reason: "execute is a generator",
  },
];

for (const c of NOT_APPLIED) {
  test(`not applied, and nothing written, for ${c.name}`, (t) => {
    const app = tempApp(t, { "agent/tools/x.ts": c.source });

    assert.deepEqual(c.codemod(app, tool("x"), IDENTITY), { applied: false, reason: c.reason, files: [] });
    assert.equal(read(app, "agent/tools/x.ts"), c.source);
    assert.equal(existsSync(join(app, ...HELPER.split("/"))), false);
  });
}

/** The tsconfig of a typed app: with it, a patch is applied only if it adds no type errors. */
const TSCONFIG = `{"compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","moduleResolution":"bundler"},"include":["agent/**/*.ts"]}`;

/** A tool whose input is typed by an interface that lacks `orderId`. */
const TYPED_INPUT = toolSource(`  async execute(input: Input, ctx) {
    return { text: input.text };
  },`, `interface Input { text: string }\n`);

test("ledger-guard refuses a synchronous execute with a declared return type", (t) => {
  const method = toolSource(`  execute(input, ctx): { ok: boolean } {\n    return { ok: true };\n  },`);
  const arrow = toolSource(`  execute: (input, ctx): { ok: boolean } => ({ ok: true }),`);
  const promised = toolSource(`  async execute(input, ctx): Promise<{ ok: boolean }> {\n    return { ok: true };\n  },`);
  const app = tempApp(t, { "agent/tools/method.ts": method, "agent/tools/arrow.ts": arrow, "agent/tools/promised.ts": promised });
  const reason = "execute is synchronous and declares its return type, which the guard would turn into a Promise";

  assert.deepEqual(applyLedgerGuard(app, tool("method"), IDENTITY), { applied: false, reason, files: [] });
  assert.deepEqual(applyLedgerGuard(app, tool("arrow"), IDENTITY), { applied: false, reason, files: [] });
  assert.equal(read(app, "agent/tools/method.ts"), method);
  assert.equal(read(app, "agent/tools/arrow.ts"), arrow);
  assert.equal(existsSync(join(app, ...HELPER.split("/"))), false);

  const after = appliedText(app, applyLedgerGuard(app, tool("promised"), IDENTITY), "agent/tools/promised.ts", promised);
  assert.ok(after.includes(`  async execute(input, ctx): Promise<{ ok: boolean }> {\n    return once(`));
});

test("a field added to a type-annotated input pattern needs the annotation to declare it", (t) => {
  const literal = toolSource(`  async execute({ text }: { text: string; orderId: string }, ctx) {\n    return { text };\n  },`);
  const named = toolSource(`  async execute({ text }: Input, ctx) {\n    return { text };\n  },`, `interface Input { text: string }\n`);
  const app = tempApp(t, { "agent/tools/literal.ts": literal, "agent/tools/named.ts": named });

  assert.deepEqual(applyLedgerGuard(app, tool("named"), ["orderId"]), {
    applied: false,
    reason: `execute's input pattern has a type annotation that does not declare "orderId"`,
    files: [],
  });
  assert.equal(read(app, "agent/tools/named.ts"), named);

  assert.equal(
    appliedText(app, applyLedgerGuard(app, tool("literal"), ["orderId"]), "agent/tools/literal.ts", literal),
    toolSource(
      `  async execute({ text, orderId }: { text: string; orderId: string }, ctx) {
    return once(opKey(ctx, { orderId }), defaultStore(), async () => {
      return { text };
    });
  },`,
      `import { defaultStore, once, opKey } from "../lib/crashtest-idempotency";\n`,
    ),
  );
});

test("the helper import gets the extension the app resolves", (t) => {
  const nodeNext = (options: string): string =>
    `{"compilerOptions":{"strict":true,"noEmit":true,"module":"NodeNext"${options}},"include":["agent/**/*.ts"]}`;
  const withRelative = NOTIFY.replace(`import { z } from "zod";\n`, `import { z } from "zod";\nimport { x } from "./x.js";\n`);
  const cases: { name: string; files: Record<string, string>; source: string; specifier: string }[] = [
    { name: "nodenext", files: { "tsconfig.json": nodeNext("") }, source: NOTIFY, specifier: "../lib/crashtest-idempotency.js" },
    {
      name: "nodenext with .ts imports",
      files: { "tsconfig.json": nodeNext(`,"allowImportingTsExtensions":true`) },
      source: NOTIFY,
      specifier: "../lib/crashtest-idempotency.ts",
    },
    {
      name: "nodenext from an extended tsconfig with comments",
      files: {
        "tsconfig.json": `// The app's settings.\n{ "extends": "./tsconfig.base.json", "include": ["agent/**/*.ts"] }\n`,
        "tsconfig.base.json": `{ "compilerOptions": { "strict": true, "noEmit": true, "moduleResolution": "nodenext", "module": "nodenext" } }`,
      },
      source: NOTIFY,
      specifier: "../lib/crashtest-idempotency.js",
    },
    { name: "no tsconfig", files: {}, source: NOTIFY, specifier: "../lib/crashtest-idempotency" },
    {
      name: "a relative .js import",
      files: { "agent/tools/x.ts": "export const x = 1;\n" },
      source: withRelative,
      specifier: "../lib/crashtest-idempotency.js",
    },
  ];

  for (const c of cases) {
    const app = tempApp(t, { ...c.files, "agent/tools/notify.ts": c.source });

    const after = appliedText(app, applyLedgerGuard(app, tool("notify"), IDENTITY), "agent/tools/notify.ts", c.source);

    assert.ok(after.includes(`import { defaultStore, once, opKey } from "${c.specifier}";\n`), `${c.name}: ${after}`);
  }
});

test("a guard that would not type-check is refused with the compiler's message", (t) => {
  const app = tempApp(t, { "tsconfig.json": TSCONFIG, "agent/tools/x.ts": TYPED_INPUT, "agent/tools/notify.ts": NOTIFY });

  const result = applyLedgerGuard(app, tool("x"), ["orderId"]);

  assert.equal(result.applied, false);
  assert.match(result.reason ?? "", /^the edited agent\/tools\/x\.ts would not type-check: agent\/tools\/x\.ts: .*orderId/);
  assert.deepEqual(result.files, []);
  assert.equal(read(app, "agent/tools/x.ts"), TYPED_INPUT);
  assert.equal(existsSync(join(app, ...HELPER.split("/"))), false);

  // A guard that type-checks, with the helper it brings, is applied in the same app.
  assert.equal(appliedText(app, applyLedgerGuard(app, tool("notify"), IDENTITY), "agent/tools/notify.ts", NOTIFY), NOTIFY_GUARDED);
});

test("an app without tsconfig.json is patched as before", (t) => {
  const app = tempApp(t, { "agent/tools/x.ts": TYPED_INPUT, "agent/tools/notify.ts": NOTIFY });

  const typed = appliedText(app, applyLedgerGuard(app, tool("x"), ["orderId"]), "agent/tools/x.ts", TYPED_INPUT);
  assert.ok(typed.includes("return once(opKey(ctx, { orderId: input.orderId }), defaultStore(), async () => {"));
  assert.equal(appliedText(app, applyLedgerGuard(app, tool("notify"), IDENTITY), "agent/tools/notify.ts", NOTIFY), NOTIFY_GUARDED);
});

test("a tool file outside the app is never touched", (t) => {
  const root = tempApp(t, { "outside.ts": NOTIFY, "app/package.json": "{}" });
  const app = join(root, "app");

  const result = applyLedgerGuard(app, { name: "outside", file: "../outside.ts", inputSchema: null }, IDENTITY);

  assert.deepEqual(result, { applied: false, reason: "tool file ../outside.ts is outside the app", files: [] });
  assert.equal(read(root, "outside.ts"), NOTIFY);
  assert.equal(existsSync(join(app, "agent")), false);

  // A directory link that leads out of the app counts as outside too ("junction" needs no privileges on Windows).
  mkdirSync(join(app, "agent"));
  symlinkSync(join(root, "elsewhere"), join(app, "agent", "tools"), "junction");
  put(root, "elsewhere/linked.ts", NOTIFY);
  const linked = applyLedgerGuard(app, tool("linked"), IDENTITY);
  assert.deepEqual(linked, { applied: false, reason: "tool file agent/tools/linked.ts is outside the app", files: [] });
  assert.equal(read(root, "elsewhere/linked.ts"), NOTIFY);
  assert.equal(existsSync(join(app, ...HELPER.split("/"))), false);
});
