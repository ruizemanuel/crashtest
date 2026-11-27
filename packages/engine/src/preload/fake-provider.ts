// Stateful fake of every HTTP service an agent under test talks to. It answers requests deterministically and
// models just enough provider state to tell a real duplicate effect (two refunds) from a benign repeat
// (re-adding a label that exists). Pure and JSON-serializable: the preload keeps the state across a crash.
import { append, handleCatalog, honorsIdempotencyKey, idempotencyConflict, nextId, own, type CatalogRequest, type Outcome } from "./catalog.ts";
import { answerKnownRead, isKnownRead } from "./known-reads.ts";
import { bodyHash, normalizeEndpoint, parseBody, redactBody, redactPath, redactUrl, sha256 } from "./normalize.ts";

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
  /**
   * The object the write targets, as the provider identifies it: for a generic PUT, PATCH or DELETE, the method and
   * the redacted `<host><path>` without the query. Detection treats two writes to one object as a possible repeat.
   */
  object?: string;
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

/** One Vercel Blob object as the fake provider saw it written or deleted. */
export interface BlobRecord {
  pathname: string;
  bodyHash: string;
  contentType: string;
  /** UTF-8 bytes of the body that was written. */
  size: number;
  deleted: boolean;
}

export interface ProviderState {
  /** Id sequences: refund, email, slack, comment, generic, and blob for the random suffixes. */
  counters: Record<string, number>;
  /** Created records by collection name: `<host><path>` for generic POSTs, `ct:<name>` for catalog ones. */
  collections: Record<string, unknown[]>;
  /** Stored response per `<host> <key>`. */
  idempotency: Record<string, IdempotencyRecord>;
  /** Set-like state, such as the labels of an issue. */
  sets: Record<string, string[]>;
  /** Body hashes already seen per `<METHOD> <host><path>` for PUT, PATCH and DELETE. */
  putHashes: Record<string, string[]>;
  /** Hash of the last content written per `WRITE <relPath>`; an APPEND to the path forgets it. */
  fsWrites: Record<string, string>;
  /** Vercel Blob objects per `blob:<pathname>`, deleted ones included. */
  blobs: Record<string, BlobRecord>;
}

export interface FakeProvider {
  handle(req: FakeRequest): FakeResult;
  fsWrite(op: "WRITE" | "APPEND", relPath: string, content: string): FakeEffect;
  state: ProviderState;
}

const NON_MUTATING = new Set(["GET", "HEAD", "OPTIONS"]);
const JSON_HEADERS = { "content-type": "application/json" };

/** The benign label of a repeat that an idempotency key deduplicated. */
export const KEY_REPLAY = "idempotency key replay";

function emptyState(): ProviderState {
  return { counters: {}, collections: {}, idempotency: {}, sets: {}, putHashes: {}, fsWrites: {}, blobs: {} };
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

/** The effect as a handler's outcome leaves it: its state change, plus the benign label and the object when it has them. */
function settledBy(effect: FakeEffect, outcome: Outcome): FakeEffect {
  return {
    ...effect,
    stateChange: outcome.stateChange,
    ...(outcome.benign === undefined ? {} : { benign: outcome.benign }),
    ...(outcome.object === undefined ? {} : { object: outcome.object }),
  };
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
    // The slot is also the object the write targets.
    const slot = `${req.method} ${req.key}`;
    const seen = own(store.putHashes, slot);
    if (req.method === "PUT" && req.headers["if-none-match"]?.trim() === "*" && seen !== undefined) {
      return { status: 412, body: { error: "precondition_failed" }, stateChange: false, object: slot };
    }
    const hash = bodyHash(req.body);
    if (seen?.includes(hash)) return { status: 200, body: { ok: true }, stateChange: false, benign: "same request repeated", object: slot };
    (store.putHashes[slot] ??= []).push(hash);
    return { status: 200, body: { ok: true }, stateChange: true, object: slot };
  }

  function handle(req: FakeRequest): FakeResult {
    const method = req.method.toUpperCase();
    const body = parseBody(req.bodyText, req.headers["content-type"]);
    const url = parseUrl(req.url);
    // A read that the provider receives as a POST (a Slack read method, a token exchange, a GraphQL query) is not
    // an effect.
    const knownRead = url !== null && isKnownRead(method, url.hostname, redactPath(url.pathname), body);
    const mutating = !NON_MUTATING.has(method) && !knownRead;
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

    if (url === null) return respond(400, { error: "invalid_url" }, effect);
    // Every state key derives from the redacted path: the state is persisted and a URL path can carry a secret.
    const path = redactPath(url.pathname);
    const request: CatalogRequest = {
      method,
      hostname: url.hostname,
      path,
      key: `${url.host}${path}`,
      query: url.searchParams,
      headers: req.headers,
      body,
      bodyBytes: Buffer.byteLength(req.bodyText, "utf8"),
      redactedBody: effect.body,
    };
    const answer = (): FakeResult => {
      const outcome = knownRead ? answerKnownRead(request, store) : (handleCatalog(request, store) ?? generic(request));
      return respond(outcome.status, outcome.body, settledBy(effect, outcome));
    };
    // A key counts only where the real service honors it. Slack, GitHub and Vercel Blob ignore the header, so a repeat
    // there is a real second effect; a host outside the catalog is assumed to honor it (detection names those hosts).
    // A known read is not mutating, so it carries no key and is answered right here.
    if (idempotencyKey === undefined || !honorsIdempotencyKey(url.hostname)) return answer();

    const slot = `${url.host} ${idempotencyKey}`;
    const hash = bodyHash(body);
    const previous = own(store.idempotency, slot);
    if (previous === undefined) {
      const result = answer();
      store.idempotency[slot] = { bodyHash: hash, status: result.status, body: result.body };
      return result;
    }
    if (previous.bodyHash === hash) return respond(previous.status, previous.body, { ...effect, benign: KEY_REPLAY });
    const conflict = idempotencyConflict(url.hostname);
    return respond(conflict.status, conflict.body, { ...effect, benign: "idempotency key reused with different body" });
  }

  function fsWrite(op: "WRITE" | "APPEND", relPath: string, content: string): FakeEffect {
    const endpoint = `${op} ${relPath}`;
    const effect: FakeEffect = { mutating: true, stateChange: true, endpoint, body: redactBody(parseBody(content)) };
    const slot = `WRITE ${relPath}`;
    if (op === "APPEND") {
      delete store.fsWrites[slot];
      return effect;
    }
    const hash = sha256(content);
    if (own(store.fsWrites, slot) === hash) return { ...effect, stateChange: false, benign: "same content rewritten" };
    store.fsWrites[slot] = hash;
    return effect;
  }

  return { handle, fsWrite, state: store };
}
