// Pure helpers shared by the fake provider: endpoint normalization, body parsing and secret redaction.
// Loaded inside the agent's own process, so no dependencies and no I/O.

const REDACTED = "[redacted]";
const MAX_TEXT_CHARS = 4096;
const SENSITIVE_KEY = /token|secret|password|api_?key|authorization/i;
// A bare `key` query parameter is the conventional API-key parameter (Google APIs and others).
const SENSITIVE_QUERY_KEY = /^key$/i;

const ID_SHAPES = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /^[0-9a-f]{8,}$/i,
  // Provider ids such as ch_3Nabc123 and re_ct_000001. Requiring a digit keeps words like payment_intents literal.
  /^(?=.*\d)[A-Za-z]+_[A-Za-z0-9_]{6,}$/,
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdLike(segment: string): boolean {
  return ID_SHAPES.some((shape) => shape.test(segment));
}

function normalizeSegment(segment: string): string {
  if (isIdLike(segment)) return ":id";
  const dot = segment.lastIndexOf(".");
  // "4213.pdf": only the stem is an id, the extension stays.
  if (dot > 0 && isIdLike(segment.slice(0, dot))) return `:id${segment.slice(dot)}`;
  return segment;
}

/** `"<METHOD> <host><path>"` with the query dropped and id-like path segments replaced by `:id`. */
export function normalizeEndpoint(method: string, url: string): string {
  const verb = method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `${verb} ${url.split(/[?#]/, 1)[0]}`;
  }
  const path = parsed.pathname.split("/").map(normalizeSegment).join("/");
  return `${verb} ${parsed.host}${path}`;
}

function parseForm(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const previous = out[key];
    if (previous === undefined) out[key] = value;
    else out[key] = Array.isArray(previous) ? [...previous, value] : [previous, value];
  }
  return out;
}

/** JSON and form-urlencoded bodies become objects; anything else is text truncated to 4 KB. */
export function parseBody(text: string, contentType?: string): unknown {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) return parseForm(text);
  const start = text.trimStart()[0];
  if (type.includes("json") || start === "{" || start === "[") {
    try {
      return JSON.parse(text);
    } catch {
      // Not valid JSON after all: keep it as text.
    }
  }
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

/** Replaces the value of every sensitive key, recursively. */
export function redactBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactBody);
  if (!isRecord(body)) return body;
  return Object.fromEntries(Object.entries(body).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redactBody(value)]));
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    return raw;
  }
}

/** Redacts Telegram-style `bot<digits>:<secret>` segments, the one kind of secret that lives in a URL path. */
export function redactPath(path: string): string {
  return path.replace(/\/bot\d+:[^/]*/g, `/bot${REDACTED}`);
}

/** Redacts sensitive query parameters and secret path segments, keeping the rest verbatim. */
export function redactUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const queryAt = beforeHash.indexOf("?");
  const base = redactPath(queryAt >= 0 ? beforeHash.slice(0, queryAt) : beforeHash);
  if (queryAt < 0) return base + hash;
  const query = beforeHash
    .slice(queryAt + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return pair;
      const rawName = pair.slice(0, eq);
      const name = decodeName(rawName);
      return SENSITIVE_KEY.test(name) || SENSITIVE_QUERY_KEY.test(name) ? `${rawName}=${REDACTED}` : pair;
    })
    .join("&");
  return `${base}?${query}${hash}`;
}
