import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  defaultStore,
  fileStore,
  once,
  opKey,
  OutcomeUnknownError,
  redisRestStore,
  type OpRecord,
  type Store,
} from "../../templates/idempotency.ts";

const CTX = { session: { id: "s1", turn: { id: "t1" } }, toolName: "notify" };
const STARTED: OpRecord = { state: "started" };
const UNKNOWN_MESSAGE =
  "OUTCOME_UNKNOWN: a previous attempt of this operation started but did not finish; check whether it took effect before retrying.";

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-idempotency-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isOutcomeUnknown(error: unknown): boolean {
  return error instanceof OutcomeUnknownError && error.code === "OUTCOME_UNKNOWN" && error.message === UNKNOWN_MESSAGE;
}

function setEnv(t: TestContext, values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    const before = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
}

interface RedisCall {
  url: string;
  method: string | undefined;
  authorization: string | null;
  body: string;
}

/** Stubs the global fetch with a tiny Redis REST server (GET, SET, SET NX); no network. */
function fakeRedis(t: TestContext): { calls: RedisCall[]; data: Map<string, string> } {
  const calls: RedisCall[] = [];
  const data = new Map<string, string>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    calls.push({
      url: String(input),
      method: init?.method,
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    const [command, key, value, flag] = JSON.parse(body) as string[];
    if (command === "GET") return Response.json({ result: data.get(key!) ?? null });
    if (command === "SET" && flag === "NX") {
      if (data.has(key!)) return Response.json({ result: null });
      data.set(key!, value!);
      return Response.json({ result: "OK" });
    }
    if (command === "SET") {
      data.set(key!, value!);
      return Response.json({ result: "OK" });
    }
    return Response.json({ error: `ERR unknown command ${String(command)}` }, { status: 400 });
  });
  return { calls, data };
}

function replyWith(t: TestContext, response: () => Response): void {
  t.mock.method(globalThis, "fetch", async () => response());
}

// ---------------------------------------------------------------- opKey

test("opKey is the sha256 of session, turn, tool and the identity with its keys sorted", () => {
  const expected = createHash("sha256")
    .update(JSON.stringify(["s1", "t1", "notify", { a: 1, b: { c: 3, d: 4 } }]))
    .digest("hex");
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(opKey(CTX, { b: { d: 4, c: 3 }, a: 1 }), expected);
});

test("opKey ignores the order of identity keys at every depth and keeps array order", () => {
  assert.equal(opKey(CTX, { a: 1, b: 2 }), opKey(CTX, { b: 2, a: 1 }));
  assert.equal(opKey(CTX, { x: { a: 1, b: [{ q: 1, r: 2 }] } }), opKey(CTX, { x: { b: [{ r: 2, q: 1 }], a: 1 } }));
  assert.notEqual(opKey(CTX, { list: [1, 2] }), opKey(CTX, { list: [2, 1] }));
});

test("opKey changes with the session, the turn, the tool and every identity value", () => {
  const base = opKey(CTX, { orderId: "o1" });
  assert.notEqual(base, opKey({ ...CTX, session: { id: "s2", turn: { id: "t1" } } }, { orderId: "o1" }));
  assert.notEqual(base, opKey({ ...CTX, session: { id: "s1", turn: { id: "t2" } } }, { orderId: "o1" }));
  assert.notEqual(base, opKey({ ...CTX, toolName: "refund" }, { orderId: "o1" }));
  assert.notEqual(base, opKey(CTX, { orderId: "o2" }));
  assert.notEqual(base, opKey(CTX, { orderId: "o1", to: "alice" }));
});

test("opKey does not depend on the call id", () => {
  const first = { ...CTX, callId: "call-1" };
  const replay = { ...CTX, callId: "call-2" };
  assert.equal(opKey(first, { orderId: "o1" }), opKey(replay, { orderId: "o1" }));
});

test("opKey keeps a __proto__ identity key and serializes dates like JSON does", () => {
  const withProto = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>;
  assert.notEqual(opKey(CTX, withProto), opKey(CTX, { a: 1 }));
  const day = new Date("2026-11-26T00:00:00.000Z");
  assert.equal(opKey(CTX, { when: day }), opKey(CTX, { when: day.toISOString() }));
  assert.notEqual(opKey(CTX, { when: day }), opKey(CTX, { when: new Date("2026-11-27T00:00:00.000Z") }));
});

// ---------------------------------------------------------------- once

test("once runs the operation once and then returns the stored result", async (t) => {
  const dir = join(tempDir(t), "records");
  const key = opKey(CTX, { orderId: "o1" });
  let runs = 0;
  const send = async () => {
    runs += 1;
    return { id: "msg-1", ok: true };
  };

  assert.deepEqual(await once(key, fileStore(dir), send), { id: "msg-1", ok: true });
  // A restarted process builds a new store over the same directory.
  assert.deepEqual(await once(key, fileStore(dir), send), { id: "msg-1", ok: true });
  assert.equal(runs, 1);
});

test("once gives a different operation its own run", async (t) => {
  const store = fileStore(join(tempDir(t), "records"));
  let runs = 0;
  const send = async () => ++runs;
  assert.equal(await once(opKey(CTX, { orderId: "o1" }), store, send), 1);
  assert.equal(await once(opKey(CTX, { orderId: "o2" }), store, send), 2);
  assert.equal(await once(opKey(CTX, { orderId: "o1" }), store, send), 1);
});

test("a started record makes once throw an uncertain outcome without running the operation", async (t) => {
  const store = fileStore(join(tempDir(t), "records"));
  const key = opKey(CTX, { orderId: "o1" });
  assert.equal(await store.create(key, STARTED), true);
  let runs = 0;
  await assert.rejects(
    once(key, store, async () => ++runs),
    isOutcomeUnknown,
  );
  assert.equal(runs, 0);
});

test("an operation that throws leaves the record started, so a repeat is an uncertain outcome", async (t) => {
  const store = fileStore(join(tempDir(t), "records"));
  const key = opKey(CTX, { orderId: "o1" });
  let runs = 0;
  await assert.rejects(
    once(key, store, async () => {
      runs += 1;
      throw new Error("gateway timeout");
    }),
    /gateway timeout/,
  );
  assert.deepEqual(await store.get(key), STARTED);
  await assert.rejects(
    once(key, store, async () => ++runs),
    isOutcomeUnknown,
  );
  assert.equal(runs, 1);
});

/** Silences console.warn for the test and returns what it was called with. */
function captureWarnings(t: TestContext): string[][] {
  const warnings: string[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String));
  });
  return warnings;
}

test("a result that cannot be stored is still returned, and the record stays started", async (t) => {
  const warnings = captureWarnings(t);
  const store = fileStore(join(tempDir(t), "records"));
  const key = opKey(CTX, { orderId: "o1" });
  let runs = 0;
  // A BigInt cannot be serialized, so the "done" record cannot be written after the effect happened.
  assert.equal(await once(key, store, async () => BigInt(++runs) * 4242424242n), 4242424242n);
  assert.deepEqual(await store.get(key), STARTED);
  // A repeat cannot know the outcome, and does not run the effect again.
  await assert.rejects(
    once(key, store, async () => ++runs),
    isOutcomeUnknown,
  );
  assert.equal(runs, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!.join(" "), /crashtest-idempotency: .*could not be stored.*BigInt.*OUTCOME_UNKNOWN/);
  assert.doesNotMatch(warnings[0]!.join(" "), /4242424242/, "the result itself is never printed");
});

test("a store that fails after the effect still lets once return the result, without printing it or the token", async (t) => {
  const warnings = captureWarnings(t);
  const { data } = fakeRedis(t);
  const store = redisRestStore({ url: "https://redis.example", token: "secret-token" });
  // An Upstash 5xx on the write of the "done" record, after the effect.
  const failingPut: Store = {
    get: store.get,
    create: store.create,
    async put() {
      throw new Error("redisRestStore: SET failed with HTTP 503");
    },
  };
  const result = { refundId: "re_secret_result" };
  assert.deepEqual(await once("k1", failingPut, async () => result), result);
  assert.equal(data.get("k1"), JSON.stringify(STARTED));
  await assert.rejects(once("k1", store, async () => "again"), isOutcomeUnknown);
  assert.equal(warnings.length, 1);
  const text = warnings[0]!.join(" ");
  assert.match(text, /SET failed with HTTP 503/);
  assert.doesNotMatch(text, /re_secret_result|secret-token/);
});

test("two concurrent calls on a file store run the operation once and the loser gets an uncertain outcome", async (t) => {
  const dir = join(tempDir(t), "records");
  const key = opKey(CTX, { orderId: "o1" });
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Two stores over one directory stand in for two processes.
  const call = (store: Store) =>
    once(key, store, async () => {
      runs += 1;
      await gate;
      return "sent";
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const outcomes = [call(fileStore(dir)), call(fileStore(dir))];

  // The winner is held at the gate, so the first call to settle is the loser.
  const loser = await Promise.race(outcomes);
  assert.ok("error" in loser && isOutcomeUnknown(loser.error));
  release();
  const settled = await Promise.all(outcomes);
  assert.equal(runs, 1);
  assert.deepEqual(settled.filter((outcome) => "value" in outcome), [{ value: "sent" }]);
  assert.deepEqual(await fileStore(dir).get(key), { state: "done", result: "sent" });
});

/** A store that loses the create race: it reads empty, refuses the create, then shows what the winner wrote. */
function lostRace(winner: OpRecord | null): Store & { reads: number } {
  const store = {
    reads: 0,
    async get() {
      store.reads += 1;
      return store.reads === 1 ? null : winner;
    },
    async create() {
      return false;
    },
    async put() {
      throw new Error("the loser must not write");
    },
  };
  return store;
}

test("a lost create race re-reads the record and applies the same rules", async () => {
  let runs = 0;
  const run = async () => ++runs;

  const finished = lostRace({ state: "done", result: "winner result" });
  assert.equal(await once("k", finished, run), "winner result");
  assert.equal(finished.reads, 2);

  await assert.rejects(once("k", lostRace(STARTED), run), isOutcomeUnknown);
  await assert.rejects(once("k", lostRace(null), run), isOutcomeUnknown);
  assert.equal(runs, 0);
});

// ---------------------------------------------------------------- fileStore

test("fileStore reads nothing for a missing record and refuses to create over an existing one", async (t) => {
  const dir = join(tempDir(t), "records");
  const store = fileStore(dir);
  assert.equal(await store.get("k1"), null);
  assert.equal(await store.create("k1", STARTED), true);
  assert.equal(await store.create("k1", { state: "done", result: 1 }), false);
  assert.deepEqual(await store.get("k1"), STARTED);
});

test("fileStore put replaces the record atomically and leaves no temp files behind", async (t) => {
  const dir = join(tempDir(t), "records");
  const store = fileStore(dir);
  await store.create("k1", STARTED);
  await store.put("k1", { state: "done", result: { id: 7, tags: ["a"] } });
  assert.deepEqual(await store.get("k1"), { state: "done", result: { id: 7, tags: ["a"] } });
  assert.deepEqual(readdirSync(dir), ["k1.json"]);
});

test("fileStore keeps a result of undefined", async (t) => {
  const store = fileStore(join(tempDir(t), "records"));
  await store.put("k1", { state: "done", result: undefined });
  assert.deepEqual(await store.get("k1"), { state: "done", result: undefined });
  assert.equal(await once("k1", store, async () => "again"), undefined);
});

test("a record that cannot be parsed counts as started, so once reports an uncertain outcome", async (t) => {
  const dir = join(tempDir(t), "records");
  mkdirSync(dir, { recursive: true });
  const store = fileStore(dir);
  const unreadable = { "cut-off": '{"state":"do', empty: "", garbage: "not json", "no state": "{}", "json null": "null", "other state": '{"state":"pending"}' };
  for (const [key, text] of Object.entries(unreadable)) {
    const name = key.replaceAll(" ", "-");
    writeFileSync(join(dir, `${name}.json`), text);
    assert.deepEqual(await store.get(name), STARTED, key);
    let runs = 0;
    await assert.rejects(
      once(name, store, async () => ++runs),
      isOutcomeUnknown,
      key,
    );
    assert.equal(runs, 0, key);
  }
});

test("a record that cannot be read counts as started", async (t) => {
  const dir = join(tempDir(t), "records");
  mkdirSync(join(dir, "k1.json"), { recursive: true });
  assert.deepEqual(await fileStore(dir).get("k1"), STARTED);
});

test("fileStore only writes inside its directory and rejects keys that are not plain file names", async (t) => {
  const root = tempDir(t);
  const store = fileStore(join(root, "records"));
  const keys = ["", ".", "..", "../outside", "a/b", "a\\b", "a.json", "c:x", "UPPER", "a b", "a\0b", "a".repeat(129)];
  for (const key of keys) {
    await assert.rejects(store.get(key), /fileStore: key/, JSON.stringify(key));
    await assert.rejects(store.create(key, STARTED), /fileStore: key/, JSON.stringify(key));
    await assert.rejects(store.put(key, STARTED), /fileStore: key/, JSON.stringify(key));
  }
  assert.deepEqual(readdirSync(root), []);
  // Op-keys and other lowercase names go through.
  const hex = opKey(CTX, { orderId: "o1" });
  assert.equal(await store.create(hex, STARTED), true);
  assert.equal(await store.create("order-42_a", STARTED), true);
  assert.deepEqual(readdirSync(join(root, "records")).sort(), [`${hex}.json`, "order-42_a.json"].sort());
});

test("fileStore takes its directory from CRASHTEST_IDEMPOTENCY_DIR, then from .crashtest-idempotency", async (t) => {
  // Registered before tempDir so the working directory is restored before the temp directory is removed.
  const cwd = process.cwd();
  t.after(() => process.chdir(cwd));
  const root = tempDir(t);
  const fromEnv = join(root, "from-env");
  setEnv(t, { CRASHTEST_IDEMPOTENCY_DIR: fromEnv });
  await fileStore().create("k1", STARTED);
  assert.deepEqual(readdirSync(fromEnv), ["k1.json"]);

  setEnv(t, { CRASHTEST_IDEMPOTENCY_DIR: undefined });
  process.chdir(root);
  await fileStore().create("k2", STARTED);
  assert.deepEqual(readdirSync(join(root, ".crashtest-idempotency")), ["k2.json"]);
});

// ---------------------------------------------------------------- redisRestStore

test("redisRestStore sends the exact commands, with the bearer token, to the REST url", async (t) => {
  const { calls, data } = fakeRedis(t);
  const store = redisRestStore({ url: "https://redis.example", token: "secret-token" });
  const done: OpRecord = { state: "done", result: { id: 1 } };

  assert.equal(await store.get("k1"), null);
  assert.equal(await store.create("k1", STARTED), true);
  assert.equal(await store.create("k1", STARTED), false);
  await store.put("k1", done);
  assert.deepEqual(await store.get("k1"), done);

  assert.deepEqual(
    calls.map((call) => call.body),
    [
      JSON.stringify(["GET", "k1"]),
      JSON.stringify(["SET", "k1", JSON.stringify(STARTED), "NX"]),
      JSON.stringify(["SET", "k1", JSON.stringify(STARTED), "NX"]),
      JSON.stringify(["SET", "k1", JSON.stringify(done)]),
      JSON.stringify(["GET", "k1"]),
    ],
  );
  for (const call of calls) {
    assert.equal(call.url, "https://redis.example");
    assert.equal(call.method, "POST");
    assert.equal(call.authorization, "Bearer secret-token");
  }
  assert.equal(data.get("k1"), JSON.stringify(done));
});

test("redisRestStore reads its url and token from the Upstash environment variables", async (t) => {
  const { calls } = fakeRedis(t);
  setEnv(t, { UPSTASH_REDIS_REST_URL: "https://env.example", UPSTASH_REDIS_REST_TOKEN: "env-token" });
  await redisRestStore().get("k1");
  assert.equal(calls[0]?.url, "https://env.example");
  assert.equal(calls[0]?.authorization, "Bearer env-token");
});

test("once runs the operation once over redisRestStore", async (t) => {
  fakeRedis(t);
  const store = redisRestStore({ url: "https://redis.example", token: "secret-token" });
  const key = opKey(CTX, { orderId: "o1" });
  let runs = 0;
  const send = async () => ({ sent: ++runs });
  assert.deepEqual(await once(key, store, send), { sent: 1 });
  assert.deepEqual(await once(key, store, send), { sent: 1 });
  assert.equal(runs, 1);
});

test("redisRestStore counts a stored value it cannot parse as started", async (t) => {
  const { data } = fakeRedis(t);
  data.set("k1", '{"state":"do');
  const store = redisRestStore({ url: "https://redis.example", token: "secret-token" });
  assert.deepEqual(await store.get("k1"), STARTED);
});

test("redisRestStore without a url or a token throws and names what is missing", (t) => {
  setEnv(t, { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined });
  assert.throws(() => redisRestStore(), /UPSTASH_REDIS_REST_URL.*UPSTASH_REDIS_REST_TOKEN/);
  assert.throws(() => redisRestStore({ url: "https://redis.example" }), /UPSTASH_REDIS_REST_TOKEN/);
  assert.throws(() => redisRestStore({ token: "secret-token" }), (error: unknown) => {
    return error instanceof Error && /UPSTASH_REDIS_REST_URL/.test(error.message) && !error.message.includes("secret-token");
  });
});

test("redisRestStore throws on a non-2xx response and on a Redis error body, without leaking the token", async (t) => {
  const store = redisRestStore({ url: "https://redis.example", token: "secret-token" });
  const clean = (pattern: RegExp) => (error: unknown) =>
    error instanceof Error && pattern.test(error.message) && !error.message.includes("secret-token");

  replyWith(t, () => new Response("Unauthorized", { status: 401 }));
  await assert.rejects(store.get("k1"), clean(/redisRestStore.*GET.*401/));

  replyWith(t, () => Response.json({ error: "ERR syntax error" }));
  await assert.rejects(store.create("k1", STARTED), clean(/redisRestStore.*SET.*ERR syntax error/));

  replyWith(t, () => Response.json({ error: "WRONGTYPE" }, { status: 400 }));
  await assert.rejects(store.put("k1", STARTED), clean(/redisRestStore.*SET.*WRONGTYPE/));

  replyWith(t, () => Response.json({ result: "PONG" }));
  await assert.rejects(store.create("k1", STARTED), clean(/redisRestStore.*unexpected/));

  replyWith(t, () => new Response("not json"));
  await assert.rejects(store.get("k1"), clean(/redisRestStore.*GET/));
});

// ---------------------------------------------------------------- defaultStore

test("defaultStore uses Redis when both Upstash variables are set", async (t) => {
  const { calls } = fakeRedis(t);
  setEnv(t, { UPSTASH_REDIS_REST_URL: "https://env.example", UPSTASH_REDIS_REST_TOKEN: "env-token" });
  assert.equal(await defaultStore().create("k1", STARTED), true);
  assert.equal(calls.length, 1);
});

test("defaultStore falls back to the file store when a variable is missing or empty", async (t) => {
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async () => {
    calls.push("fetch");
    throw new Error("no network in this test");
  });
  const dir = join(tempDir(t), "records");
  setEnv(t, { CRASHTEST_IDEMPOTENCY_DIR: dir, UPSTASH_REDIS_REST_URL: "https://env.example", UPSTASH_REDIS_REST_TOKEN: undefined });
  assert.equal(await defaultStore().create("k1", STARTED), true);

  setEnv(t, { UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: "env-token" });
  assert.equal(await defaultStore().create("k2", STARTED), true);

  setEnv(t, { UPSTASH_REDIS_REST_URL: "", UPSTASH_REDIS_REST_TOKEN: "" });
  assert.equal(await defaultStore().create("k3", STARTED), true);

  assert.deepEqual(calls, []);
  assert.deepEqual(readdirSync(dir).sort(), ["k1.json", "k2.json", "k3.json"]);
  assert.equal(readFileSync(join(dir, "k1.json"), "utf8"), JSON.stringify(STARTED));
});
