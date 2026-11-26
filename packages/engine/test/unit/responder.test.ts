import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { MockModelResponder } from "eve/evals";
import { createResponder, type ResponderScript } from "../../templates/responder.ts";

const PID = 4242;

const INTERRUPTED =
  'An infrastructure failure interrupted your previous attempt at this step before its results were saved. It made these tool calls:\n- notify {"to":"alice"}: The step running this call was interrupted. The call may or may not have taken effect.\nBefore repeating a call that changes anything outside this conversation, check whether it already took effect.';
const COMPLETED_LOST =
  'An infrastructure failure interrupted your previous attempt at this step before its results were saved. It made these tool calls:\n- notify {"to":"alice"}: This call completed, but its result was lost when the step running it was interrupted.\nBefore repeating a call that changes anything outside this conversation, check whether it already took effect.';

function script(idMode: ResponderScript["idMode"], overrides: Partial<ResponderScript> = {}): ResponderScript {
  return {
    tool: "notify",
    input: { to: "alice", orderId: "o1", text: "Hi" },
    idMode,
    freeTextFields: ["text"],
    ...overrides,
  };
}

function lab(t: TestContext, value: ResponderScript): string {
  const runDir = mkdtempSync(join(tmpdir(), "ct-responder-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  writeFileSync(join(runDir, "script.json"), JSON.stringify(value));
  return runDir;
}

function state(runDir: string): { emits: number; retried: boolean } {
  return JSON.parse(readFileSync(join(runDir, "responder.json"), "utf8"));
}

function request(options: { messages?: Array<{ role: string; text: string }>; toolResults?: Array<{ name: string }> } = {}) {
  return { messages: options.messages ?? [{ role: "user", text: "go" }], toolResults: options.toolResults ?? [] };
}

function note(text: string) {
  return request({ messages: [{ role: "user", text: "go" }, { role: "user", text }] });
}

test("stable: first emission has no id; replay emits the same input", (t) => {
  const runDir = lab(t, script("stable"));
  const first = createResponder({ runDir, pid: PID })(request());
  assert.deepEqual(first, { toolCalls: [{ name: "notify", input: { to: "alice", orderId: "o1", text: "Hi" } }] });
  assert.ok(typeof first === "object" && !("id" in first.toolCalls[0]!));
  // A restarted process builds a new responder over the same run directory.
  const replay = createResponder({ runDir, pid: 9999 })(request());
  assert.deepEqual(replay, first);
  assert.equal(state(runDir).emits, 2);
});

test("fresh: replay gets a new id and rewritten text, identity unchanged", (t) => {
  const runDir = lab(t, script("fresh"));
  const first = createResponder({ runDir, pid: PID })(request());
  assert.deepEqual(first, {
    toolCalls: [{ name: "notify", id: `ct-call-1-${PID}`, input: { to: "alice", orderId: "o1", text: "Hi" } }],
  });
  const replay = createResponder({ runDir, pid: PID })(request());
  assert.deepEqual(replay, {
    toolCalls: [
      { name: "notify", id: `ct-call-2-${PID}`, input: { to: "alice", orderId: "o1", text: "Hi (rewritten 2)" } },
    ],
  });
});

test("fresh: only string free-text fields are rewritten", (t) => {
  const runDir = lab(t, script("fresh", { input: { to: "alice", text: "Hi", count: 3 }, freeTextFields: ["text", "count", "missing"] }));
  const respond = createResponder({ runDir, pid: PID });
  respond(request());
  const replay = respond(request());
  assert.ok(typeof replay === "object");
  assert.deepEqual(replay.toolCalls[0]!.input, { to: "alice", text: "Hi (rewritten 2)", count: 3 });
});

test("fresh: the id embeds the process pid, which defaults to process.pid", (t) => {
  const runDir = lab(t, script("fresh"));
  const out = createResponder({ runDir })(request());
  assert.ok(typeof out === "object");
  assert.equal(out.toolCalls[0]!.id, `ct-call-1-${process.pid}`);
});

test("tool result present -> done", (t) => {
  const runDir = lab(t, script("stable"));
  const out = createResponder({ runDir, pid: PID })(request({ toolResults: [{ name: "notify" }] }));
  assert.equal(out, "crashtest: done");
  assert.throws(() => state(runDir), { code: "ENOENT" }, "no emission, so nothing is persisted");
});

test("a result from another tool does not count", (t) => {
  const runDir = lab(t, script("stable"));
  const out = createResponder({ runDir, pid: PID })(request({ toolResults: [{ name: "lookup" }] }));
  assert.ok(typeof out === "object");
  assert.equal(out.toolCalls[0]!.name, "notify");
});

test("uncertain note -> one fresh retry, then done", (t) => {
  const runDir = lab(t, script("stable"));
  createResponder({ runDir, pid: PID })(request()); // the attempt that was interrupted
  const respond = createResponder({ runDir, pid: 5151 });
  const retry = respond(note(INTERRUPTED));
  assert.deepEqual(retry, {
    toolCalls: [
      { name: "notify", id: "ct-call-2-5151", input: { to: "alice", orderId: "o1", text: "Hi (rewritten 2)" } },
    ],
  });
  assert.deepEqual(state(runDir), { emits: 2, retried: true });
  assert.equal(respond(note(INTERRUPTED)), "crashtest: done");
  assert.equal(state(runDir).emits, 2);
});

test("completed-but-lost note -> no retry", (t) => {
  const runDir = lab(t, script("stable"));
  const respond = createResponder({ runDir, pid: PID });
  assert.equal(respond(note(COMPLETED_LOST)), "crashtest: done");
  assert.throws(() => state(runDir), { code: "ENOENT" });
});

test("note about another tool -> normal emission", (t) => {
  const runDir = lab(t, script("stable"));
  const other = INTERRUPTED.replace("- notify ", "- lookup ");
  const out = createResponder({ runDir, pid: PID })(note(other));
  assert.deepEqual(out, { toolCalls: [{ name: "notify", input: { to: "alice", orderId: "o1", text: "Hi" } }] });
  assert.equal(state(runDir).retried, false);
});

test("a tool whose name only starts with the tool under test does not match the note", (t) => {
  const runDir = lab(t, script("stable"));
  const prefixed = INTERRUPTED.replace("- notify {", "- notify_all {");
  const out = createResponder({ runDir, pid: PID })(note(prefixed));
  assert.ok(typeof out === "object", "emits normally instead of treating the note as its own");
});

test("a note that is not a user message is ignored", (t) => {
  const runDir = lab(t, script("stable"));
  const out = createResponder({ runDir, pid: PID })(
    request({ messages: [{ role: "user", text: "go" }, { role: "assistant", text: INTERRUPTED }] }),
  );
  assert.ok(typeof out === "object");
  assert.equal(state(runDir).retried, false);
});

test("tool names are matched literally, not as a pattern", (t) => {
  const runDir = lab(t, script("stable", { tool: "send.mail" }));
  const decoy = INTERRUPTED.replace("- notify ", "- sendXmail ");
  const out = createResponder({ runDir, pid: PID })(note(decoy));
  assert.ok(typeof out === "object", "sendXmail is not send.mail");
  const real = INTERRUPTED.replace("- notify ", "- send.mail ");
  const retry = createResponder({ runDir, pid: PID })(note(real));
  assert.ok(typeof retry === "object");
  assert.equal(state(runDir).retried, true);
});

test("a note without a tool input still matches", (t) => {
  const runDir = lab(t, script("stable"));
  const bare = INTERRUPTED.replace('- notify {"to":"alice"}:', "- notify:");
  const out = createResponder({ runDir, pid: PID })(note(bare));
  assert.ok(typeof out === "object");
  assert.equal(state(runDir).retried, true);
});

test("script.json is re-read on every call", (t) => {
  const runDir = lab(t, script("stable"));
  const respond = createResponder({ runDir, pid: PID });
  respond(request());
  writeFileSync(join(runDir, "script.json"), JSON.stringify(script("fresh", { input: { to: "bob", orderId: "o2", text: "Yo" } })));
  const out = respond(request());
  assert.deepEqual(out, {
    toolCalls: [{ name: "notify", id: `ct-call-2-${PID}`, input: { to: "bob", orderId: "o2", text: "Yo (rewritten 2)" } }],
  });
});

test("the runDir defaults to CT_RUN_DIR", (t) => {
  const runDir = lab(t, script("stable"));
  const previous = process.env.CT_RUN_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.CT_RUN_DIR;
    else process.env.CT_RUN_DIR = previous;
  });
  process.env.CT_RUN_DIR = runDir;
  assert.ok(typeof createResponder()(request()) === "object");
  assert.equal(state(runDir).emits, 1);
});

test("fails loudly without a run directory, a script or readable state", (t) => {
  const previous = process.env.CT_RUN_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.CT_RUN_DIR;
    else process.env.CT_RUN_DIR = previous;
  });
  delete process.env.CT_RUN_DIR;
  assert.throws(() => createResponder()(request()), /CT_RUN_DIR/);
  const empty = mkdtempSync(join(tmpdir(), "ct-responder-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => createResponder({ runDir: empty })(request()), { code: "ENOENT" });
  const runDir = lab(t, script("stable"));
  writeFileSync(join(runDir, "responder.json"), "{not json");
  assert.throws(() => createResponder({ runDir })(request()), SyntaxError);
});

test("the responder is assignable to eve's mock model responder", (t) => {
  const runDir = lab(t, script("stable"));
  const responder: MockModelResponder = createResponder({ runDir, pid: PID });
  assert.equal(typeof responder, "function");
});
