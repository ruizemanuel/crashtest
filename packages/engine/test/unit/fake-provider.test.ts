import assert from "node:assert/strict";
import { test } from "node:test";
import { hostSupportsIdempotency, hostSupportsLookup } from "../../src/preload/catalog.ts";
import { createFakeProvider, type FakeRequest, type FakeResult, type Fixture } from "../../src/preload/fake-provider.ts";
import { normalizeEndpoint, parseBody, redactBody, redactUrl } from "../../src/preload/normalize.ts";

const FORM = { "content-type": "application/x-www-form-urlencoded" };

function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): FakeRequest {
  if (body === undefined) return { method, url, headers, bodyText: "" };
  if (typeof body === "string") return { method, url, headers, bodyText: body };
  return { method, url, headers: { "content-type": "application/json", ...headers }, bodyText: JSON.stringify(body) };
}
const post = (url: string, body?: unknown, headers?: Record<string, string>) => req("POST", url, body, headers);
const get = (url: string, headers?: Record<string, string>) => req("GET", url, undefined, headers);

function expectEffect(r: FakeResult, want: { status: number; stateChange: boolean; benign?: string; endpoint: string }): void {
  assert.equal(r.status, want.status);
  assert.equal(r.effect.stateChange, want.stateChange);
  assert.equal(r.effect.benign, want.benign);
  assert.equal(r.effect.endpoint, want.endpoint);
}

test("fixture match answers with the fixture and marks mutating requests as state changes", () => {
  const fixtures: Fixture[] = [
    { method: "post", url: "https://api.acme.test/*/orders", status: 201, body: { id: "o1" } },
    { url: "https://status.acme.test/*" },
  ];
  const p = createFakeProvider(null, fixtures);
  const created = p.handle(post("https://api.acme.test/v1/eu/orders", { sku: "a" }));
  expectEffect(created, { status: 201, stateChange: true, endpoint: "POST api.acme.test/v1/eu/orders" });
  assert.deepEqual(created.body, { id: "o1" });
  const read = p.handle(get("https://status.acme.test/health?full=1"));
  expectEffect(read, { status: 200, stateChange: false, endpoint: "GET status.acme.test/health" });
  assert.deepEqual(read.body, {});
  assert.equal(read.effect.mutating, false);
  // The method restriction and the anchored glob both apply: this one falls through to the generic provider.
  const other = p.handle(req("PUT", "https://api.acme.test/v1/eu/orders", { a: 1 }));
  assert.deepEqual(other.body, { ok: true });
});

test("fixtures take precedence over idempotency keys and the catalog", () => {
  const p = createFakeProvider(null, [{ url: "https://api.stripe.com/*", status: 503, body: { error: "down" } }]);
  const headers = { "idempotency-key": "k1" };
  const first = p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_1" }, headers));
  const second = p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_1" }, headers));
  for (const r of [first, second]) expectEffect(r, { status: 503, stateChange: true, endpoint: "POST api.stripe.com/v1/refunds" });
  assert.equal(first.effect.idempotencyKey, "k1");
});

test("idempotency key replay with the same body returns the stored response and changes nothing", () => {
  const p = createFakeProvider(null);
  const url = "https://api.stripe.com/v1/refunds";
  const first = p.handle(post(url, { charge: "ch_1", amount: 500 }, { "idempotency-key": "k1" }));
  expectEffect(first, { status: 200, stateChange: true, endpoint: "POST api.stripe.com/v1/refunds" });
  assert.equal(first.effect.idempotencyKey, "k1");
  const replay = p.handle(post(url, { amount: 500, charge: "ch_1" }, { "idempotency-key": "k1" }));
  expectEffect(replay, { status: 200, stateChange: false, benign: "idempotency key replay", endpoint: "POST api.stripe.com/v1/refunds" });
  assert.deepEqual(replay.body, first.body);
  // Nothing new was created by the replay.
  assert.equal((p.handle(get(`${url}?charge=ch_1`)).body as { data: unknown[] }).data.length, 1);
});

test("the x-idempotency-key header is honored and keys are scoped per host", () => {
  const p = createFakeProvider(null);
  const a = p.handle(post("https://api.acme.test/v1/m", { k: 1 }, { "x-idempotency-key": "k1" }));
  const b = p.handle(post("https://api.other.test/v1/m", { k: 1 }, { "x-idempotency-key": "k1" }));
  assert.equal(a.effect.stateChange, true);
  assert.equal(b.effect.stateChange, true);
  assert.equal(b.effect.benign, undefined);
  const replay = p.handle(post("https://api.acme.test/v1/m", { k: 1 }, { "x-idempotency-key": "k1" }));
  assert.equal(replay.effect.benign, "idempotency key replay");
});

test("an idempotency key reused with a different body is rejected per provider", () => {
  const cases: Array<{ url: string; status: number; body: unknown }> = [
    { url: "https://api.stripe.com/v1/refunds", status: 400, body: { error: { type: "idempotency_error" } } },
    { url: "https://api.resend.com/emails", status: 409, body: { name: "invalid_idempotent_request" } },
    { url: "https://api.acme.test/v1/m", status: 409, body: { error: "idempotency_key_reused" } },
  ];
  for (const c of cases) {
    const p = createFakeProvider(null);
    p.handle(post(c.url, { n: 1 }, { "idempotency-key": "k1" }));
    const r = p.handle(post(c.url, { n: 2 }, { "idempotency-key": "k1" }));
    assert.equal(r.status, c.status, c.url);
    assert.equal(r.effect.stateChange, false, c.url);
    assert.equal(r.effect.benign, "idempotency key reused with different body", c.url);
    assert.deepEqual(r.body, c.body, c.url);
  }
});

test("POST stripe refunds creates a refund from a form or a JSON body", () => {
  const p = createFakeProvider(null);
  const form = p.handle(post("https://api.stripe.com/v1/refunds", "charge=ch_3Nabc123&amount=500", FORM));
  expectEffect(form, { status: 200, stateChange: true, endpoint: "POST api.stripe.com/v1/refunds" });
  assert.deepEqual(form.body, { id: "re_ct_000001", object: "refund", charge: "ch_3Nabc123", amount: 500, status: "succeeded" });
  const json = p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_3Nabc123", amount: 500 }));
  expectEffect(json, { status: 200, stateChange: true, endpoint: "POST api.stripe.com/v1/refunds" });
  assert.deepEqual(json.body, { id: "re_ct_000002", object: "refund", charge: "ch_3Nabc123", amount: 500, status: "succeeded" });
});

test("GET stripe refunds lists only the refunds of the requested charge", () => {
  const p = createFakeProvider(null);
  p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_a", amount: 1 }));
  p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_b", amount: 2 }));
  p.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_a", amount: 3 }));
  const r = p.handle(get("https://api.stripe.com/v1/refunds?charge=ch_a"));
  expectEffect(r, { status: 200, stateChange: false, endpoint: "GET api.stripe.com/v1/refunds" });
  const body = r.body as { object: string; data: Array<{ amount: number }> };
  assert.equal(body.object, "list");
  assert.deepEqual(body.data.map((x) => x.amount), [1, 3]);
});

test("POST slack chat.postMessage appends a message", () => {
  const p = createFakeProvider(null);
  const r = p.handle(post("https://slack.com/api/chat.postMessage", { channel: "C1", text: "hi" }));
  expectEffect(r, { status: 200, stateChange: true, endpoint: "POST slack.com/api/chat.postMessage" });
  assert.deepEqual(r.body, { ok: true, channel: "C1", ts: "1.000100" });
  const form = p.handle(post("https://slack.com/api/chat.postMessage", "channel=C1&text=again", FORM));
  assert.deepEqual(form.body, { ok: true, channel: "C1", ts: "2.000100" });
});

test("GET slack conversations.history returns the channel messages newest first", () => {
  const p = createFakeProvider(null);
  p.handle(post("https://slack.com/api/chat.postMessage", { channel: "C1", text: "one" }));
  p.handle(post("https://slack.com/api/chat.postMessage", { channel: "C2", text: "elsewhere" }));
  p.handle(post("https://slack.com/api/chat.postMessage", { channel: "C1", text: "two" }));
  const r = p.handle(get("https://slack.com/api/conversations.history?channel=C1"));
  expectEffect(r, { status: 200, stateChange: false, endpoint: "GET slack.com/api/conversations.history" });
  const body = r.body as { ok: boolean; messages: Array<{ text: string; ts: string; channel: string }> };
  assert.equal(body.ok, true);
  assert.deepEqual(body.messages.map((m) => m.text), ["two", "one"]);
  assert.deepEqual(body.messages[0], { ts: "3.000100", channel: "C1", text: "two" });
});

test("POST resend emails creates an email", () => {
  const p = createFakeProvider(null);
  const r = p.handle(post("https://api.resend.com/emails", { from: "a@x.test", to: "b@x.test", subject: "Hello", html: "<p>x</p>" }));
  expectEffect(r, { status: 200, stateChange: true, endpoint: "POST api.resend.com/emails" });
  assert.deepEqual(r.body, { id: "em_ct_000001" });
});

test("GET resend emails lists the sent emails", () => {
  const p = createFakeProvider(null);
  p.handle(post("https://api.resend.com/emails", { to: "b@x.test", subject: "Hello" }));
  p.handle(post("https://api.resend.com/emails", { to: "c@x.test", subject: "Again" }));
  const r = p.handle(get("https://api.resend.com/emails"));
  expectEffect(r, { status: 200, stateChange: false, endpoint: "GET api.resend.com/emails" });
  const data = (r.body as { data: Array<{ id: string; to: string }> }).data;
  assert.deepEqual(data.map((e) => [e.id, e.to]), [["em_ct_000001", "b@x.test"], ["em_ct_000002", "c@x.test"]]);
});

test("POST github issue labels is a set-add: a repeat is benign", () => {
  const p = createFakeProvider(null);
  const url = "https://api.github.com/repos/acme/support/issues/7/labels";
  const endpoint = "POST api.github.com/repos/acme/support/issues/:id/labels";
  const first = p.handle(post(url, { labels: ["bug", "p1"] }));
  expectEffect(first, { status: 200, stateChange: true, endpoint });
  assert.deepEqual(first.body, [{ name: "bug" }, { name: "p1" }]);
  const repeat = p.handle(post(url, { labels: ["bug"] }));
  expectEffect(repeat, { status: 200, stateChange: false, benign: "labels already present", endpoint });
  assert.deepEqual(repeat.body, [{ name: "bug" }, { name: "p1" }]);
  const partial = p.handle(post(url, { labels: ["bug", "docs"] }));
  expectEffect(partial, { status: 200, stateChange: true, endpoint });
  assert.deepEqual(partial.body, [{ name: "bug" }, { name: "p1" }, { name: "docs" }]);
});

test("GET github issue labels returns the labels, scoped to the issue", () => {
  const p = createFakeProvider(null);
  p.handle(post("https://api.github.com/repos/acme/support/issues/7/labels", { labels: ["bug"] }));
  p.handle(post("https://api.github.com/repos/acme/support/issues/8/labels", { labels: ["docs"] }));
  const r = p.handle(get("https://api.github.com/repos/acme/support/issues/7/labels"));
  expectEffect(r, { status: 200, stateChange: false, endpoint: "GET api.github.com/repos/acme/support/issues/:id/labels" });
  assert.deepEqual(r.body, [{ name: "bug" }]);
  assert.deepEqual(p.handle(get("https://api.github.com/repos/acme/support/issues/9/labels")).body, []);
});

test("POST github issue comments appends a comment each time", () => {
  const p = createFakeProvider(null);
  const url = "https://api.github.com/repos/acme/support/issues/7/comments";
  const endpoint = "POST api.github.com/repos/acme/support/issues/:id/comments";
  const a = p.handle(post(url, { body: "same" }));
  const b = p.handle(post(url, { body: "same" }));
  expectEffect(a, { status: 201, stateChange: true, endpoint });
  expectEffect(b, { status: 201, stateChange: true, endpoint });
  assert.notEqual((a.body as { id: number }).id, (b.body as { id: number }).id);
});

test("generic POST appends to the collection of its path", () => {
  const p = createFakeProvider(null);
  const a = p.handle(post("https://api.acme.test/v1/orders", { sku: "a" }));
  const b = p.handle(post("https://api.acme.test/v1/orders", { sku: "a" }));
  expectEffect(a, { status: 200, stateChange: true, endpoint: "POST api.acme.test/v1/orders" });
  expectEffect(b, { status: 200, stateChange: true, endpoint: "POST api.acme.test/v1/orders" });
  assert.deepEqual(a.body, { ok: true, id: "ct_000001" });
  assert.deepEqual(b.body, { ok: true, id: "ct_000002" });
});

test("generic PUT with if-none-match on a path already PUT is a precondition failure", () => {
  const p = createFakeProvider(null);
  const url = "https://files.acme.test/receipts/4213.pdf";
  const endpoint = "PUT files.acme.test/receipts/:id.pdf";
  const headers = { "if-none-match": "*" };
  const first = p.handle(req("PUT", url, "pdf-bytes", headers));
  expectEffect(first, { status: 200, stateChange: true, endpoint });
  const second = p.handle(req("PUT", url, "pdf-bytes", headers));
  expectEffect(second, { status: 412, stateChange: false, endpoint });
  assert.deepEqual(second.body, { error: "precondition_failed" });
  // Another path is unaffected.
  expectEffect(p.handle(req("PUT", "https://files.acme.test/receipts/4214.pdf", "x", headers)), { status: 200, stateChange: true, endpoint });
});

test("generic PUT, PATCH and DELETE change state only for a (method, path, body) not seen before", () => {
  const p = createFakeProvider(null);
  const url = "https://api.acme.test/v1/things/42";
  const cases: Array<[string, unknown]> = [["PUT", { a: 1 }], ["PATCH", { a: 1 }], ["DELETE", undefined]];
  for (const [method, body] of cases) {
    const endpoint = `${method} api.acme.test/v1/things/:id`;
    expectEffect(p.handle(req(method, url, body)), { status: 200, stateChange: true, endpoint });
    const again = p.handle(req(method, url, body));
    expectEffect(again, { status: 200, stateChange: false, benign: "same request repeated", endpoint });
    assert.deepEqual(again.body, { ok: true });
  }
  // The same path with a different body is a new change.
  expectEffect(p.handle(req("PUT", url, { a: 2 })), { status: 200, stateChange: true, endpoint: "PUT api.acme.test/v1/things/:id" });
});

test("generic GET and HEAD return the bodies POSTed to the path, or {}", () => {
  const p = createFakeProvider(null);
  const url = "https://api.acme.test/v1/orders";
  assert.deepEqual(p.handle(get(url)).body, {});
  p.handle(post(url, { sku: "a" }));
  p.handle(post(url, { sku: "b" }));
  const r = p.handle(get(url));
  expectEffect(r, { status: 200, stateChange: false, endpoint: "GET api.acme.test/v1/orders" });
  assert.deepEqual(r.body, { items: [{ sku: "a" }, { sku: "b" }] });
  const head = p.handle(req("HEAD", url));
  expectEffect(head, { status: 200, stateChange: false, endpoint: "HEAD api.acme.test/v1/orders" });
  assert.equal(head.effect.mutating, false);
  assert.deepEqual(p.handle(get("https://api.acme.test/v1/other")).body, {});
});

test("non-mutating requests never change state, even with an idempotency key", () => {
  const p = createFakeProvider(null);
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const r = p.handle(req(method, "https://api.acme.test/v1/m", undefined, { "idempotency-key": "k1" }));
    assert.equal(r.effect.mutating, false, method);
    assert.equal(r.effect.stateChange, false, method);
    assert.equal(r.effect.idempotencyKey, undefined, method);
  }
  // The GETs above did not claim the key.
  assert.equal(p.handle(post("https://api.acme.test/v1/m", { k: 1 }, { "idempotency-key": "k1" })).effect.stateChange, true);
});

test("fsWrite APPEND is always a state change", () => {
  const p = createFakeProvider(null);
  const a = p.fsWrite("APPEND", "data/outbox.jsonl", '{"to":"a@x.test"}\n');
  const b = p.fsWrite("APPEND", "data/outbox.jsonl", '{"to":"a@x.test"}\n');
  for (const e of [a, b]) {
    assert.equal(e.mutating, true);
    assert.equal(e.stateChange, true);
    assert.equal(e.benign, undefined);
    assert.equal(e.endpoint, "APPEND data/outbox.jsonl");
  }
  assert.deepEqual(a.body, { to: "a@x.test" });
});

test("fsWrite WRITE is benign when the same content was already written to that path", () => {
  const p = createFakeProvider(null);
  const first = p.fsWrite("WRITE", "data/receipt.txt", "paid");
  assert.equal(first.stateChange, true);
  assert.equal(first.benign, undefined);
  assert.equal(first.endpoint, "WRITE data/receipt.txt");
  const again = p.fsWrite("WRITE", "data/receipt.txt", "paid");
  assert.equal(again.stateChange, false);
  assert.equal(again.benign, "same content rewritten");
  assert.equal(p.fsWrite("WRITE", "data/receipt.txt", "refunded").stateChange, true);
  assert.equal(p.fsWrite("WRITE", "data/other.txt", "paid").stateChange, true);
});

test("state survives JSON round-trip", () => {
  const a = createFakeProvider(null); a.handle(post("https://api.acme.test/v1/m", { k: 1 }, { "idempotency-key": "k1" }));
  const b = createFakeProvider(JSON.parse(JSON.stringify(a.state)));
  assert.equal(b.handle(post("https://api.acme.test/v1/m", { k: 1 }, { "idempotency-key": "k1" })).effect.benign, "idempotency key replay");
});

test("ids and collections continue after a JSON round-trip", () => {
  const a = createFakeProvider(null);
  a.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_1" }));
  a.handle(post("https://api.github.com/repos/o/r/issues/1/labels", { labels: ["bug"] }));
  a.fsWrite("WRITE", "f.txt", "x");
  a.handle(req("PUT", "https://api.acme.test/v1/a", { n: 1 }));
  const b = createFakeProvider(JSON.parse(JSON.stringify(a.state)));
  const refund = b.handle(post("https://api.stripe.com/v1/refunds", { charge: "ch_1" }));
  assert.equal((refund.body as { id: string }).id, "re_ct_000002");
  assert.equal((b.handle(get("https://api.stripe.com/v1/refunds?charge=ch_1")).body as { data: unknown[] }).data.length, 2);
  assert.equal(b.handle(post("https://api.github.com/repos/o/r/issues/1/labels", { labels: ["bug"] })).effect.benign, "labels already present");
  assert.equal(b.fsWrite("WRITE", "f.txt", "x").benign, "same content rewritten");
  assert.equal(b.handle(req("PUT", "https://api.acme.test/v1/a", { n: 1 })).effect.benign, "same request repeated");
});

test("redaction", () => {
  assert.deepEqual(redactBody({ token: "xoxb-1", nested: { api_key: "k" }, text: "hi" }), { token: "[redacted]", nested: { api_key: "[redacted]" }, text: "hi" });
  assert.equal(redactUrl("https://api.telegram.org/bot123:AAx-y/sendMessage?key=k&chat=1"), "https://api.telegram.org/bot[redacted]/sendMessage?key=[redacted]&chat=1");
});

test("redaction reaches arrays and every sensitive key name, and leaves other values alone", () => {
  assert.deepEqual(
    redactBody({ list: [{ Password: "p", n: 1 }, "plain", null], Authorization: "Bearer x", client_secret: "s", apikey: "k", ok: true }),
    { list: [{ Password: "[redacted]", n: 1 }, "plain", null], Authorization: "[redacted]", client_secret: "[redacted]", apikey: "[redacted]", ok: true },
  );
  assert.equal(redactBody("text"), "text");
  assert.equal(redactBody(null), null);
  assert.equal(redactUrl("https://api.acme.test/v1/items?id=1&access_token=t&page=2#frag"), "https://api.acme.test/v1/items?id=1&access_token=[redacted]&page=2#frag");
  assert.equal(redactUrl("https://api.acme.test/v1/items"), "https://api.acme.test/v1/items");
});

test("the effect never carries secrets from the url or the body", () => {
  const p = createFakeProvider(null);
  const r = p.handle(post("https://api.telegram.org/bot123:AAx-y/sendMessage?key=k&chat=1", { chat_id: 1, token: "t", text: "hi" }));
  assert.equal(r.effect.endpoint, "POST api.telegram.org/bot[redacted]/sendMessage");
  assert.deepEqual(r.effect.body, { chat_id: 1, token: "[redacted]", text: "hi" });
  assert.equal(JSON.stringify(r.effect).includes("AAx-y"), false);
  assert.equal(JSON.stringify(p.state).includes("\"t\""), false);
});

test("endpoint normalization", () => {
  assert.equal(normalizeEndpoint("PUT", "https://files.acme.test/receipts/4213.pdf?x=1"), "PUT files.acme.test/receipts/:id.pdf");
  assert.equal(normalizeEndpoint("POST", "https://api.github.com/repos/acme/support/issues/7/labels"), "POST api.github.com/repos/acme/support/issues/:id/labels");
});

test("endpoint normalization covers every id shape and keeps ordinary words", () => {
  const cases: Array<[string, string]> = [
    ["https://api.stripe.com/v1/charges/ch_3Nabc123/refunds", "POST api.stripe.com/v1/charges/:id/refunds"],
    ["https://api.stripe.com/v1/refunds/re_ct_000001", "POST api.stripe.com/v1/refunds/:id"],
    ["https://api.acme.test/v1/users/123e4567-e89b-42d3-a456-426614174000/orders", "POST api.acme.test/v1/users/:id/orders"],
    ["https://api.acme.test/v1/blobs/deadbeef01", "POST api.acme.test/v1/blobs/:id"],
    ["https://api.acme.test/v1/issues/labels/v2", "POST api.acme.test/v1/issues/labels/v2"],
    ["https://slack.com/api/chat.postMessage?token=x", "POST slack.com/api/chat.postMessage"],
    ["https://api.acme.test:8443/v1/m/", "POST api.acme.test:8443/v1/m/"],
    ["https://api.acme.test", "POST api.acme.test/"],
  ];
  for (const [url, want] of cases) assert.equal(normalizeEndpoint("post", url), want, url);
});

test("parseBody understands JSON, forms and plain text", () => {
  assert.deepEqual(parseBody('{"a":1}', "application/json"), { a: 1 });
  assert.deepEqual(parseBody("[1,2]"), [1, 2]);
  assert.deepEqual(parseBody("a=1&b=x%20y&b=z&c[d]=2", "application/x-www-form-urlencoded; charset=UTF-8"), { a: "1", b: ["x y", "z"], "c[d]": "2" });
  assert.equal(parseBody("not json", "application/json"), "not json");
  assert.equal(parseBody("plain"), "plain");
  assert.equal((parseBody("x".repeat(5000)) as string).length, 4096);
});

test("host capability helpers", () => {
  assert.equal(hostSupportsIdempotency("api.stripe.com"), true);
  assert.equal(hostSupportsIdempotency("api.resend.com"), true);
  assert.equal(hostSupportsIdempotency("slack.com"), false);
  assert.equal(hostSupportsIdempotency("api.acme.test"), false);
  for (const host of ["api.stripe.com", "slack.com", "api.resend.com", "api.github.com"]) assert.equal(hostSupportsLookup(host), true, host);
  assert.equal(hostSupportsLookup("api.acme.test"), false);
});
