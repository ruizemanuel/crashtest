// Stateful fake of every HTTP service an agent under test talks to. It answers requests deterministically and
// models just enough provider state to tell a real duplicate effect (two refunds) from a benign repeat
// (re-adding a label that exists). Pure and JSON-serializable: the preload keeps the state across a crash.
import { createHash } from "node:crypto";
import { append, handleCatalog, idempotencyConflict, nextId, own, type CatalogRequest, type Outcome } from "./catalog.ts";
import { normalizeEndpoint, parseBody, redactBody, redactUrl } from "./normalize.ts";

export interface FakeRequest {
  method: string;
  url: string;
  /** Lower-case keys. */
  headers: Record<string, string>;
  bodyText: string;
}

export interface FakeEffect {
  mutating: boolean;
  stateChange: boolean;
  benign?: string;
  endpoint: string;
  idempotencyKey?: string;
  /** Redacted. */
  body: unknown;
}

export interface FakeResult {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  effect: FakeEffect;
}

export interface Fixture {
  method?: string;
  /** Matched against the full request URL; `*` matches any run of characters, including `/`. */
  url: string;
  status?: number;
  body?: unknown;
}

export interface IdempotencyRecord {
  bodyHash: string;
  status: number;
  body: unknown;
}

export interface ProviderState {
  /** Id sequences: refund, email, slack, comment, generic. */
  counters: Record<string, number>;
  /** Created records by collection name: `<host><path>` for generic POSTs, `ct:<name>` for catalog ones. */
  collections: Record<string, unknown[]>;
  /** Stored response per `<host> <key>`. */
  idempotency: Record<string, IdempotencyRecord>;
  /** Set-like state, such as the labels of an issue. */
  sets: Record<string, string[]>;
  /** Body hashes already seen per `<METHOD> <host><path>` for PUT, PATCH and DELETE. */
  putHashes: Record<string, string[]>;
  /** Content hashes already written per `WRITE <relPath>`. */
  fsWrites: Record<string, string[]>;
}

export interface FakeProvider {
  handle(req: FakeRequest): FakeResult;
  fsWrite(op: "WRITE" | "APPEND", relPath: string, content: string): FakeEffect;
  state: ProviderState;
}

const NON_MUTATING = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_HEADERS = { "content-type": "application/json" };

function emptyState(): ProviderState {
  return { counters: {}, collections: {}, idempotency: {}, sets: {}, putHashes: {}, fsWrites: {} };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${fields.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function bodyHash(body: unknown): string {
  return sha256(canonicalJson(body));
}

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s");
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function withBenign(effect: FakeEffect, benign: string | undefined): FakeEffect {
  return benign === undefined ? effect : { ...effect, benign };
}

export function createFakeProvider(state: ProviderState | null, fixtures: Fixture[] = []): FakeProvider {
  const store = state ?? emptyState();
  const compiled = fixtures.map((fixture) => ({ fixture, pattern: globToRegExp(fixture.url) }));

  function respond(status: number, body: unknown, effect: FakeEffect): FakeResult {
    return { status, headers: { ...JSON_HEADERS }, body, effect };
  }

  function generic(req: CatalogRequest): Outcome {
    if (NON_MUTATING.has(req.method)) {
      const items = own(store.collections, req.key);
      return { status: 200, body: items ? { items: [...items] } : {}, stateChange: false };
    }
    if (req.method === "POST") {
      append(store, req.key, req.redactedBody);
      return { status: 200, body: { ok: true, id: nextId(store, "generic", "ct_") }, stateChange: true };
    }
    const slot = `${req.method} ${req.key}`;
    const seen = own(store.putHashes, slot);
    if (req.method === "PUT" && req.headers["if-none-match"]?.trim() === "*" && seen !== undefined) {
      return { status: 412, body: { error: "precondition_failed" }, stateChange: false };
    }
    const hash = bodyHash(req.body);
    if (seen?.includes(hash)) return { status: 200, body: { ok: true }, stateChange: false, benign: "same request repeated" };
    (store.putHashes[slot] ??= []).push(hash);
    return { status: 200, body: { ok: true }, stateChange: true };
  }

  function handle(req: FakeRequest): FakeResult {
    const method = req.method.toUpperCase();
    const mutating = !NON_MUTATING.has(method);
    const body = parseBody(req.bodyText, req.headers["content-type"]);
    const idempotencyKey = mutating ? req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || undefined : undefined;
    const effect: FakeEffect = {
      mutating,
      stateChange: false,
      endpoint: normalizeEndpoint(method, redactUrl(req.url)),
      body: redactBody(body),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    };

    const matched = compiled.find(({ fixture, pattern }) => (fixture.method === undefined || fixture.method.toUpperCase() === method) && pattern.test(req.url));
    if (matched) return respond(matched.fixture.status ?? 200, matched.fixture.body ?? {}, { ...effect, stateChange: mutating });

    const url = parseUrl(req.url);
    if (url === null) return respond(400, { error: "invalid_url" }, effect);
    const request: CatalogRequest = {
      method,
      hostname: url.hostname,
      path: url.pathname,
      key: `${url.host}${url.pathname}`,
      query: url.searchParams,
      headers: req.headers,
      body,
      redactedBody: effect.body,
    };
    const answer = (): FakeResult => {
      const outcome = handleCatalog(request, store) ?? generic(request);
      return respond(outcome.status, outcome.body, withBenign({ ...effect, stateChange: outcome.stateChange }, outcome.benign));
    };
    if (idempotencyKey === undefined) return answer();

    const slot = `${url.host} ${idempotencyKey}`;
    const hash = bodyHash(body);
    const previous = own(store.idempotency, slot);
    if (previous === undefined) {
      const result = answer();
      store.idempotency[slot] = { bodyHash: hash, status: result.status, body: result.body };
      return result;
    }
    if (previous.bodyHash === hash) return respond(previous.status, previous.body, { ...effect, benign: "idempotency key replay" });
    const conflict = idempotencyConflict(url.hostname);
    return respond(conflict.status, conflict.body, { ...effect, benign: "idempotency key reused with different body" });
  }

  function fsWrite(op: "WRITE" | "APPEND", relPath: string, content: string): FakeEffect {
    const endpoint = `${op} ${relPath}`;
    const effect: FakeEffect = { mutating: true, stateChange: true, endpoint, body: redactBody(parseBody(content)) };
    if (op === "APPEND") return effect;
    const hash = sha256(content);
    const written = own(store.fsWrites, endpoint);
    if (written?.includes(hash)) return { ...effect, stateChange: false, benign: "same content rewritten" };
    (store.fsWrites[endpoint] ??= []).push(hash);
    return effect;
  }

  return { handle, fsWrite, state: store };
}
