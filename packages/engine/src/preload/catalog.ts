// Host-specific behavior of the fake provider (Stripe, Slack, Resend, GitHub, Vercel Blob) plus the small state
// helpers every handler uses. Pure: all state lives in the ProviderState it is handed.
import type { BlobRecord, ProviderState } from "./fake-provider.ts";
import { bodyHash, isRecord } from "./normalize.ts";

/** A request as the handlers see it, with the method upper-cased. */
export interface CatalogRequest {
  method: string;
  hostname: string;
  path: string;
  /** `<host><path>`: where generic and comment-like POSTs are collected. */
  key: string;
  query: URLSearchParams;
  /** Lower-case keys. */
  headers: Record<string, string>;
  /** Parsed, unredacted: what the handlers read their fields from. */
  body: unknown;
  /** The UTF-8 byte length of the raw request body. */
  bodyBytes: number;
  /** What may be stored in state or shown in the ledger. */
  redactedBody: unknown;
}

export interface Outcome {
  status: number;
  body: unknown;
  stateChange: boolean;
  benign?: string;
  /** The object the write targets, as the provider identifies it (see `FakeEffect.object`). */
  object?: string;
}

/** Where the fake Vercel Blob store serves its objects: every `url` it answers starts with it. */
export const BLOB_BASE_URL = "https://ctstore.public.blob.vercel-storage.com/";

/** The hosts whose real behavior the fake provider models (see `handleCatalog`). */
const CATALOG_HOSTS = new Set(["api.stripe.com", "slack.com", "api.resend.com", "api.github.com", "vercel.com"]);
const IDEMPOTENCY_HOSTS = new Set(["api.stripe.com", "api.resend.com"]);
const LOOKUP_HOSTS = new Set(["api.stripe.com", "slack.com", "api.resend.com", "api.github.com", "vercel.com"]);

/** Whether the fake provider models the real service of `host`; any other host gets the generic answers. */
export function hostInCatalog(host: string): boolean {
  return CATALOG_HOSTS.has(host.toLowerCase());
}

/** Whether the real service honors idempotency keys. */
export function hostSupportsIdempotency(host: string): boolean {
  return IDEMPOTENCY_HOSTS.has(host.toLowerCase());
}

/**
 * Whether the fake provider honors an idempotency key sent to `host`: where the real service does, and on every host
 * outside the catalog, whose real behavior is unknown (a rating that rests on that says it is assumed).
 */
export function honorsIdempotencyKey(host: string): boolean {
  return hostSupportsIdempotency(host) || !hostInCatalog(host);
}

/** Whether the real service offers a read endpoint an agent could use to look an effect up before repeating it. */
export function hostSupportsLookup(host: string): boolean {
  return LOOKUP_HOSTS.has(host.toLowerCase());
}

// State helpers. Keys can come from agent-controlled strings, so reads go through Object.hasOwn.

export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function nextCount(state: ProviderState, counter: string): number {
  const next = (own(state.counters, counter) ?? 0) + 1;
  state.counters[counter] = next;
  return next;
}

export function nextId(state: ProviderState, counter: string, prefix: string): string {
  // Zero-padded so the id keeps its "<letters>_<alnum >= 6>" shape and normalizes to :id inside paths.
  return `${prefix}${String(nextCount(state, counter)).padStart(6, "0")}`;
}

export function listOf(state: ProviderState, name: string): unknown[] {
  return own(state.collections, name) ?? [];
}

export function append(state: ProviderState, name: string, item: unknown): void {
  (state.collections[name] ??= []).push(item);
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function amount(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function ok(body: unknown, stateChange: boolean, status = 200): Outcome {
  return { status, body, stateChange };
}

/** What the provider answers when an idempotency key is reused with a different body. */
export function idempotencyConflict(hostname: string): { status: number; body: unknown } {
  if (hostname === "api.stripe.com") return { status: 400, body: { error: { type: "idempotency_error" } } };
  if (hostname === "api.resend.com") return { status: 409, body: { name: "invalid_idempotent_request" } };
  return { status: 409, body: { error: "idempotency_key_reused" } };
}

function stripe(req: CatalogRequest, state: ProviderState): Outcome | null {
  if (req.path !== "/v1/refunds") return null;
  if (req.method === "POST") {
    const fields = isRecord(req.body) ? req.body : {};
    const refund = {
      id: nextId(state, "refund", "re_ct_"),
      object: "refund",
      charge: text(fields.charge),
      amount: amount(fields.amount),
      status: "succeeded",
    };
    append(state, "ct:stripe.refunds", refund);
    return ok(refund, true);
  }
  if (req.method === "GET") {
    const charge = req.query.get("charge");
    const data = listOf(state, "ct:stripe.refunds").filter((r) => charge === null || (isRecord(r) && r.charge === charge));
    return ok({ object: "list", data }, false);
  }
  return null;
}

function slack(req: CatalogRequest, state: ProviderState): Outcome | null {
  if (req.method === "POST" && req.path === "/api/chat.postMessage") {
    const fields = isRecord(req.body) ? req.body : {};
    const channel = text(fields.channel) ?? "";
    const ts = `${nextCount(state, "slack")}.000100`;
    append(state, `ct:slack.messages:${channel}`, { ts, channel, text: text(fields.text) ?? "" });
    return ok({ ok: true, channel, ts }, true);
  }
  // The read methods (conversations.history and the rest) are answered as known reads (see known-reads.ts).
  return null;
}

const EMAIL_FIELDS = ["from", "to", "subject"] as const;

function resend(req: CatalogRequest, state: ProviderState): Outcome | null {
  if (req.path !== "/emails") return null;
  if (req.method === "POST") {
    const fields = isRecord(req.body) ? req.body : {};
    const id = nextId(state, "email", "em_ct_");
    // The lookup endpoint needs enough of the email to recognize it.
    const email: Record<string, unknown> = { id };
    for (const name of EMAIL_FIELDS) if (fields[name] !== undefined) email[name] = fields[name];
    append(state, "ct:resend.emails", email);
    return ok({ id }, true);
  }
  if (req.method === "GET") return ok({ data: listOf(state, "ct:resend.emails") }, false);
  return null;
}

const ISSUE_LABELS = /^\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/labels$/;
const ISSUE_COMMENTS = /^\/repos\/[^/]+\/[^/]+\/issues\/[^/]+\/comments$/;

function labelNames(body: unknown): string[] {
  const raw = isRecord(body) && Array.isArray(body.labels) ? body.labels : [];
  return raw.flatMap((label) => {
    const name = typeof label === "string" ? label : isRecord(label) ? text(label.name) : null;
    return name === null ? [] : [name];
  });
}

function github(req: CatalogRequest, state: ProviderState): Outcome | null {
  const issue = ISSUE_LABELS.exec(req.path);
  if (issue) {
    const setName = `ct:github.labels:${issue[1]}/${issue[2]}#${issue[3]}`;
    const labels = own(state.sets, setName) ?? [];
    if (req.method === "GET") return ok(labels.map((name) => ({ name })), false);
    if (req.method === "POST") {
      // A set-add: only labels not on the issue yet change anything.
      const added = [...new Set(labelNames(req.body))].filter((name) => !labels.includes(name));
      const all = [...labels, ...added];
      if (added.length > 0) state.sets[setName] = all;
      const response = all.map((name) => ({ name }));
      return added.length > 0 ? ok(response, true) : { ...ok(response, false), benign: "labels already present" };
    }
  }
  if (req.method === "POST" && ISSUE_COMMENTS.test(req.path)) {
    append(state, req.key, req.redactedBody);
    return ok({ id: nextCount(state, "comment") }, true, 201);
  }
  return null;
}

// Vercel Blob, with the request shapes of @vercel/blob 2.4.0: put is `PUT /api/blob/?pathname=`, delete is
// `POST /api/blob/delete` with `{ urls }`, head is `GET /api/blob?url=` and list is `GET /api/blob?prefix=&mode=`.
const BLOB_API_PATHS = new Set(["/api/blob", "/api/blob/"]);
const BLOB_DELETE_PATH = "/api/blob/delete";
const BLOB_UPLOADED_AT = "1970-01-01T00:00:00.000Z";
const BLOB_CACHE_CONTROL = "public, max-age=2592000";
const BLOB_EXISTS = "This blob already exists, use allowOverwrite: true to overwrite it";
const BLOB_NOT_FOUND = "The requested blob does not exist";

function blobKey(pathname: string): string {
  return `blob:${pathname}`;
}

/**
 * The pathname a target names. A full blob URL (one that starts with `http://` or `https://`, as the client tells
 * them apart) names its percent-decoded path without the leading `/`.
 */
function targetPathname(target: string): string {
  if (!/^https?:\/\//i.test(target)) return target;
  let path: string;
  try {
    path = new URL(target).pathname.slice(1);
  } catch {
    return target;
  }
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** `-ct<n>` inserted before the extension of the last path segment, or appended when it has none. */
function withRandomSuffix(pathname: string, n: number): string {
  const dot = pathname.lastIndexOf(".");
  const at = dot > pathname.lastIndexOf("/") + 1 ? dot : pathname.length;
  return `${pathname.slice(0, at)}-ct${n}${pathname.slice(at)}`;
}

function liveBlob(state: ProviderState, pathname: string): BlobRecord | undefined {
  const blob = own(state.blobs, blobKey(pathname));
  return blob === undefined || blob.deleted ? undefined : blob;
}

function putFields(blob: BlobRecord): Record<string, string> {
  const url = `${BLOB_BASE_URL}${blob.pathname}`;
  const basename = blob.pathname.slice(blob.pathname.lastIndexOf("/") + 1);
  return {
    url,
    downloadUrl: `${url}?download=1`,
    pathname: blob.pathname,
    contentType: blob.contentType,
    contentDisposition: `inline; filename="${basename}"`,
    etag: `"${blob.bodyHash.slice(0, 16)}"`,
  };
}

function blobError(status: number, code: string, message: string): Outcome {
  return { status, body: { error: { code, message } }, stateChange: false };
}

function blobPut(req: CatalogRequest, state: ProviderState): Outcome | null {
  const requested = req.query.get("pathname");
  if (!requested) return null;
  const suffixed = req.headers["x-add-random-suffix"]?.trim() === "1";
  const pathname = suffixed ? withRandomSuffix(requested, nextCount(state, "blob")) : requested;
  const previous = liveBlob(state, pathname);
  // A refused write names no object: a later write of its body is no repeat of anything that was stored.
  if (!suffixed && previous !== undefined && req.headers["x-allow-overwrite"]?.trim() !== "1") {
    return blobError(400, "bad_request", BLOB_EXISTS);
  }
  const blob: BlobRecord = {
    pathname,
    bodyHash: bodyHash(req.body),
    contentType: req.headers["x-content-type"] || "application/octet-stream",
    size: req.bodyBytes,
    deleted: false,
  };
  state.blobs[blobKey(pathname)] = blob;
  const object = `vercel-blob:${pathname}`;
  if (!suffixed && previous?.bodyHash === blob.bodyHash) return { ...ok(putFields(blob), false), benign: "same object written again", object };
  return { ...ok(putFields(blob), true), object };
}

/** A delete takes an object the lab never saw as one that exists: the lab cannot know the real store. */
function blobDelete(req: CatalogRequest, state: ProviderState): Outcome | null {
  const urls = isRecord(req.body) && Array.isArray(req.body.urls) ? req.body.urls : null;
  if (urls === null) return null;
  let changed = false;
  for (const target of urls) {
    if (typeof target !== "string") continue;
    const pathname = targetPathname(target);
    const blob = own(state.blobs, blobKey(pathname));
    if (blob?.deleted) continue;
    const tombstone: BlobRecord = blob === undefined ? { pathname, bodyHash: "", contentType: "", size: 0, deleted: true } : { ...blob, deleted: true };
    state.blobs[blobKey(pathname)] = tombstone;
    changed = true;
  }
  return changed ? ok({}, true) : { ...ok({}, false), benign: "objects already deleted" };
}

function byPathname(a: BlobRecord, b: BlobRecord): number {
  return a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0;
}

/** Head (`?url=`) and list. Both take an object the lab never saw as absent. */
function blobRead(req: CatalogRequest, state: ProviderState): Outcome {
  const target = req.query.get("url");
  if (target !== null) {
    const blob = liveBlob(state, targetPathname(target));
    if (blob === undefined) return blobError(404, "not_found", BLOB_NOT_FOUND);
    return ok({ ...putFields(blob), size: blob.size, uploadedAt: BLOB_UPLOADED_AT, cacheControl: BLOB_CACHE_CONTROL }, false);
  }
  const prefix = req.query.get("prefix") ?? "";
  const blobs = Object.values(state.blobs)
    .filter((blob) => !blob.deleted && blob.pathname.startsWith(prefix))
    .sort(byPathname)
    .map((blob) => {
      const { url, downloadUrl, pathname } = putFields(blob);
      return { url, downloadUrl, pathname, size: blob.size, uploadedAt: BLOB_UPLOADED_AT };
    });
  return ok({ blobs, hasMore: false, folders: [] }, false);
}

function vercelBlob(req: CatalogRequest, state: ProviderState): Outcome | null {
  if (req.method === "POST" && req.path === BLOB_DELETE_PATH) return blobDelete(req, state);
  if (!BLOB_API_PATHS.has(req.path)) return null;
  if (req.method === "PUT") return blobPut(req, state);
  if (req.method === "GET") return blobRead(req, state);
  return null;
}

/** Answers requests to a known host, or returns null so the generic provider handles them. */
export function handleCatalog(req: CatalogRequest, state: ProviderState): Outcome | null {
  switch (req.hostname) {
    case "api.stripe.com":
      return stripe(req, state);
    case "slack.com":
      return slack(req, state);
    case "api.resend.com":
      return resend(req, state);
    case "api.github.com":
      return github(req, state);
    case "vercel.com":
      return vercelBlob(req, state);
    default:
      return null;
  }
}
