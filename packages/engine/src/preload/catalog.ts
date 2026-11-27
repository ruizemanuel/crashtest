// Host-specific behavior of the fake provider (Stripe, Slack, Resend, GitHub) plus the small state helpers
// every handler uses. Pure: all state lives in the ProviderState it is handed.
import type { ProviderState } from "./fake-provider.ts";
import { isRecord } from "./normalize.ts";

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

/** The hosts whose real behavior the fake provider models (see `handleCatalog`). */
const CATALOG_HOSTS = new Set(["api.stripe.com", "slack.com", "api.resend.com", "api.github.com"]);
const IDEMPOTENCY_HOSTS = new Set(["api.stripe.com", "api.resend.com"]);
const LOOKUP_HOSTS = new Set(["api.stripe.com", "slack.com", "api.resend.com", "api.github.com"]);

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
    default:
      return null;
  }
}
