import assert from "node:assert/strict";
import { test } from "node:test";
import { freeTextFields, identityFields, sampleInput } from "../../src/inputs.ts";

const S = {
  type: "object",
  required: ["to", "orderId", "amount", "text", "kind"],
  properties: {
    to: { type: "string" },
    orderId: { type: "string" },
    amount: { type: "integer", minimum: 100 },
    text: { type: "string" },
    kind: { type: "string", enum: ["shipped", "refunded"] },
    email: { type: "string", format: "email" },
    tags: { type: "array", items: { type: "string" } },
    urgent: { type: "boolean" },
  },
};

test("sampleInput", () =>
  assert.deepEqual(sampleInput(S), {
    to: "alice",
    orderId: "orderId_ct_1",
    amount: 100,
    text: "crashtest text",
    kind: "shipped",
    email: "alice@example.test",
    tags: ["crashtest tags"],
    urgent: true,
  }));

test("sampleInput keeps declared property order", () => {
  assert.deepEqual(Object.keys(sampleInput(S)), Object.keys(S.properties));
});

test("sampleInput without a usable schema is empty", () => {
  assert.deepEqual(sampleInput(null), {});
  assert.deepEqual(sampleInput({ type: "object" }), {});
  assert.deepEqual(sampleInput({ type: "string" }), {});
});

test("sampleInput: const, formats and name hints", () => {
  const schema = {
    type: "object",
    properties: {
      version: { const: 3 },
      contactEmail: { type: "string" },
      callbackUrl: { type: "string" },
      website: { type: "string", format: "uri" },
      createdAt: { type: "string", format: "date-time" },
      day: { type: "string", format: "date" },
      recipient: { type: "string" },
      customer: { type: "string" },
      user: { type: "string" },
      userId: { type: "string" },
      ticket_id: { type: "string" },
      id: { type: "string" },
    },
  };
  assert.deepEqual(sampleInput(schema), {
    version: 3,
    contactEmail: "alice@example.test",
    callbackUrl: "https://example.test/r/1",
    website: "https://example.test/r/1",
    createdAt: "2026-01-01T00:00:00.000Z",
    day: "2026-01-01",
    recipient: "alice",
    customer: "alice",
    user: "alice",
    userId: "userId_ct_1",
    ticket_id: "ticket_id_ct_1",
    id: "id_ct_1",
  });
});

test("sampleInput: enum wins over name hints and formats", () => {
  const schema = {
    type: "object",
    properties: {
      to: { type: "string", enum: ["bob", "carol"] },
      email: { type: "string", format: "email", enum: ["x@y.test"] },
    },
  };
  assert.deepEqual(sampleInput(schema), { to: "bob", email: "x@y.test" });
});

test("sampleInput: string length bounds", () => {
  const schema = {
    type: "object",
    properties: {
      pin: { type: "string", minLength: 20 },
      code: { type: "string", maxLength: 6 },
    },
  };
  const out = sampleInput(schema) as { pin: string; code: string };
  assert.equal(out.pin, "crashtest pin".padEnd(20, "x"));
  assert.equal(out.code, "crasht");
});

test("sampleInput: numbers, arrays, objects, unions and refs", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ratio: { type: "number", minimum: 0.5 },
      items: { type: "array", minItems: 3, items: { type: "integer", minimum: 7 } },
      nested: {
        type: "object",
        properties: { sku: { type: "string" }, note: { type: "string" } },
      },
      either: { anyOf: [{ type: "null" }, { type: "string" }] },
      one: { oneOf: [{ type: "boolean" }, { type: "string" }] },
      nullable: { type: ["null", "string"] },
      linked: { $ref: "#/$defs/Thing" },
    },
  };
  assert.deepEqual(sampleInput(schema), {
    count: 1,
    ratio: 0.5,
    items: [7, 7, 7],
    nested: { sku: "crashtest sku", note: "crashtest note" },
    either: "crashtest either",
    one: true,
    nullable: "crashtest nullable",
    linked: "crashtest linked",
  });
});

test("freeTextFields", () => {
  assert.deepEqual(freeTextFields(S), ["text"]);
  assert.deepEqual(freeTextFields(S, ["kind"]), ["kind"]);
});

test("freeTextFields: name rules, suffixes and exclusions", () => {
  const schema = {
    type: "object",
    properties: {
      Subject: { type: "string" },
      bodyText: { type: "string" },
      errorMessage: { type: "string" },
      requestBody: { type: "string" },
      note: { type: "string", enum: ["a"] },
      title: { type: "string", format: "email" },
      comment: { type: "string", const: "fixed" },
      summary: { type: "integer" },
      sku: { type: "string" },
      context: { type: "string" },
    },
  };
  assert.deepEqual(freeTextFields(schema), ["Subject", "bodyText", "errorMessage", "requestBody"]);
});

test("freeTextFields: a configured list wins, also without a schema", () => {
  assert.deepEqual(freeTextFields(null), []);
  assert.deepEqual(freeTextFields(null, ["body"]), ["body"]);
  assert.deepEqual(freeTextFields(S, []), []);
});

test("identityFields", () => assert.deepEqual(identityFields(S, ["text"]), ["to", "orderId", "amount", "kind"]));

test("identityFields: required scalars only, in schema order", () => {
  const schema = {
    type: "object",
    required: ["flag", "id", "meta", "list", "note"],
    properties: {
      note: { type: "string" },
      id: { type: "string" },
      optional: { type: "string" },
      flag: { type: "boolean" },
      meta: { type: "object", properties: {} },
      list: { type: "array", items: { type: "string" } },
    },
  };
  assert.deepEqual(identityFields(schema, ["note"]), ["id", "flag"]);
  assert.deepEqual(identityFields(schema, []), ["note", "id", "flag"]);
});

test("identityFields: a configured list wins, also without a schema", () => {
  assert.deepEqual(identityFields(S, ["text"], ["orderId"]), ["orderId"]);
  assert.deepEqual(identityFields(null, [], ["orderId"]), ["orderId"]);
  assert.deepEqual(identityFields(null, []), []);
  assert.deepEqual(identityFields({ type: "object", properties: { a: { type: "string" } } }, []), []);
});
