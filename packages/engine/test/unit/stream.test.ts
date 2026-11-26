import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStream } from "../../src/driver/stream.ts";

const lines = (...objs: unknown[]): string => objs.map((x) => JSON.stringify(x)).join("\n");

test("calls, interactions and turn outcome", () => {
  const nd =
    [
      { facts: [{ type: "call.requested", data: { callId: "c1", capability: { name: "notify" } } }, { type: "interaction.opened", data: { interactionId: "i1" } }] },
      { facts: [{ type: "interaction.settled", data: { interactionId: "i1" } }, { type: "call.settled", data: { callId: "c1", outcome: "abandoned" } }] },
      { facts: [{ type: "call.requested", data: { callId: "c2", capability: { name: "notify" } } }, { type: "call.settled", data: { callId: "c2", outcome: "completed", output: { ok: true } } }, { type: "turn.settled", data: { outcome: "completed" } }] },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\nnot json\n";
  const s = parseStream(nd);
  assert.deepEqual(s.calls.map((c) => [c.callId, c.outcome]), [["c1", "abandoned"], ["c2", "completed"]]);
  assert.deepEqual(s.openInteractions, []);
  assert.equal(s.turnOutcome, "completed");
});

test("tool name, output and error come from the facts", () => {
  const s = parseStream(
    lines({
      facts: [
        { type: "call.requested", data: { callId: "c1", capability: { name: "refund" } } },
        { type: "call.settled", data: { callId: "c1", outcome: "failed", error: { message: "boom" } } },
        { type: "call.requested", data: { callId: "c2", capability: { name: "notify" } } },
        { type: "call.settled", data: { callId: "c2", outcome: "completed", output: { ok: true } } },
      ],
    }),
  );
  assert.deepEqual(s.calls, [
    { callId: "c1", tool: "refund", outcome: "failed", error: { message: "boom" } },
    { callId: "c2", tool: "notify", outcome: "completed", output: { ok: true } },
  ]);
});

test("a call that never settled stays requested", () => {
  const s = parseStream(lines({ facts: [{ type: "call.requested", data: { callId: "c1", capability: { name: "notify" } } }] }));
  assert.deepEqual(s.calls, [{ callId: "c1", tool: "notify", outcome: "requested" }]);
  assert.equal(s.turnOutcome, null);
});

test("an interaction without a later settle stays open", () => {
  const s = parseStream(
    lines(
      { facts: [{ type: "interaction.opened", data: { interactionId: "i1" } }, { type: "interaction.opened", data: { interactionId: "i2" } }] },
      { facts: [{ type: "interaction.settled", data: { interactionId: "i1" } }, { type: "interaction.opened", data: { interactionId: "i1" } }] },
      { facts: [{ type: "interaction.settled", data: { interactionId: "i2" } }] },
    ),
  );
  assert.deepEqual(s.openInteractions, ["i1"]);
});

test("the last turn.settled wins", () => {
  const s = parseStream(
    lines(
      { facts: [{ type: "turn.settled", data: { outcome: "failed" } }] },
      { facts: [{ type: "turn.settled", data: { outcome: "completed" } }] },
    ),
  );
  assert.equal(s.turnOutcome, "completed");
});

test("malformed input is skipped, not thrown", () => {
  const nd = ["", "null", "[1]", '{"facts":"x"}', '{"facts":[null,1,{"type":"call.settled"}]}', "{oops"].join("\n");
  assert.deepEqual(parseStream(nd), { calls: [], openInteractions: [], turnOutcome: null });
});
