// Reads that real providers receive as POST: Slack Web API read methods, token exchanges and GraphQL queries. They
// change nothing, so they are not effects: never counted, never the crash point. Pure: loaded inside the agent's
// own process too.
import { listOf, type CatalogRequest, type Outcome } from "./catalog.ts";
import type { ProviderState } from "./fake-provider.ts";
import { isRecord } from "./normalize.ts";

interface KnownRead {
  /** Lower-case host, or null for any host. */
  host: string | null;
  methods: ReadonlySet<string>;
  /** `path` is the redacted path; `body` the parsed one. */
  matches: (path: string, body: unknown) => boolean;
  status?: number;
  body: (req: CatalogRequest, state: ProviderState) => unknown;
}

const GET_OR_POST: ReadonlySet<string> = new Set(["GET", "POST"]);
const POST: ReadonlySet<string> = new Set(["POST"]);

const SLACK_MESSAGE_READS = new Set(["/api/conversations.history", "/api/conversations.replies"]);
const SLACK_PLAIN_READS = new Set([
  "/api/conversations.list",
  "/api/conversations.members",
  "/api/users.info",
  "/api/users.list",
  "/api/users.lookupByEmail",
  "/api/users.conversations",
  "/api/auth.test",
  "/api/team.info",
  "/api/bots.info",
  "/api/chat.getPermalink",
  "/api/reactions.get",
  "/api/pins.list",
  "/api/search.messages",
  "/api/files.info",
]);
const GITHUB_INSTALLATION_TOKEN = /^\/app\/installations\/[^/]+\/access_tokens$/;
const GRAPHQL_NAME = /[_A-Za-z][_0-9A-Za-z]*/y;
const GRAPHQL_WRITES = new Set(["mutation", "subscription"]);
const GRAPHQL_OPEN = new Set(["{", "(", "["]);
const GRAPHQL_CLOSE = new Set(["}", ")", "]"]);

/** The channel a Slack read names: in the query, else in the form or JSON body. */
function slackChannel(req: CatalogRequest): string {
  const fromQuery = req.query.get("channel");
  if (fromQuery !== null) return fromQuery;
  const fromBody = isRecord(req.body) ? req.body.channel : undefined;
  return typeof fromBody === "string" ? fromBody : "";
}

/** The index just after the GraphQL string (`"..."` or `"""..."""`) that starts at `start`, or -1 if it never ends. */
function graphqlStringEnd(text: string, start: number): number {
  if (text.startsWith('"""', start)) {
    // A block string: `\"""` is its only escape.
    for (let from = start + 3; ; ) {
      const close = text.indexOf('"""', from);
      if (close === -1) return -1;
      if (text.charAt(close - 1) !== "\\") return close + 3;
      from = close + 3;
    }
  }
  for (let i = start + 1; i < text.length; i++) {
    const char = text.charAt(i);
    if (char === "\\") i++;
    else if (char === '"') return i + 1;
    else if (char === "\n" || char === "\r") return -1;
  }
  return -1;
}

/**
 * Whether a GraphQL document may write: a `mutation` or `subscription` name at its top level, outside every `{}`,
 * `()` and `[]`, every string and every `#` comment. A document that cannot be read to its end (an unclosed string or
 * bracket) counts as one that writes.
 */
function graphqlMayWrite(document: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < document.length) {
    const char = document.charAt(i);
    if (char === "#") {
      while (i < document.length && document.charAt(i) !== "\n" && document.charAt(i) !== "\r") i++;
    } else if (char === '"') {
      i = graphqlStringEnd(document, i);
      if (i === -1) return true;
    } else if (GRAPHQL_OPEN.has(char) || GRAPHQL_CLOSE.has(char)) {
      depth += GRAPHQL_OPEN.has(char) ? 1 : -1;
      if (depth < 0) return true;
      i++;
    } else {
      GRAPHQL_NAME.lastIndex = i;
      const name = GRAPHQL_NAME.exec(document)?.[0];
      if (name !== undefined && depth === 0 && GRAPHQL_WRITES.has(name)) return true;
      i += name?.length ?? 1;
    }
  }
  return depth !== 0;
}

/** A body with a `query` text that has no `mutation` or `subscription` operation. */
function isGraphqlQuery(body: unknown): boolean {
  return isRecord(body) && typeof body.query === "string" && !graphqlMayWrite(body.query);
}

const KNOWN_READS: readonly KnownRead[] = [
  {
    host: "slack.com",
    methods: GET_OR_POST,
    matches: (path) => SLACK_MESSAGE_READS.has(path),
    // Newest first, as Slack lists them.
    body: (req, state) => ({ ok: true, messages: listOf(state, `ct:slack.messages:${slackChannel(req)}`).toReversed() }),
  },
  {
    host: "slack.com",
    methods: GET_OR_POST,
    matches: (path) => path === "/api/conversations.info",
    body: (req) => {
      const channel = slackChannel(req);
      return { ok: true, channel: { id: channel, name: channel, is_member: true } };
    },
  },
  { host: "slack.com", methods: GET_OR_POST, matches: (path) => SLACK_PLAIN_READS.has(path), body: () => ({ ok: true }) },
  {
    host: "api.vercel.com",
    methods: POST,
    matches: (path) => path.startsWith("/v1/connect/token/"),
    body: () => ({ ok: true, token: "ct-fake-connect-token" }),
  },
  {
    host: "api.github.com",
    methods: POST,
    matches: (path) => GITHUB_INSTALLATION_TOKEN.test(path),
    // GitHub answers a new installation token with 201 Created.
    status: 201,
    body: () => ({ token: "ct-fake-installation-token", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "all" }),
  },
  { host: null, methods: POST, matches: (path, body) => path.endsWith("/graphql") && isGraphqlQuery(body), body: () => ({ data: {} }) },
];

function findKnownRead(method: string, hostname: string, path: string, body: unknown): KnownRead | undefined {
  const verb = method.toUpperCase();
  const host = hostname.toLowerCase();
  return KNOWN_READS.find((read) => (read.host === null || read.host === host) && read.methods.has(verb) && read.matches(path, body));
}

/** Whether a request only reads, by its method, its host, its redacted path and its parsed body. */
export function isKnownRead(method: string, hostname: string, path: string, body: unknown): boolean {
  return findKnownRead(method, hostname, path, body) !== undefined;
}

/** The answer to a request that `isKnownRead` accepts. It never changes the provider state. */
export function answerKnownRead(req: CatalogRequest, state: ProviderState): Outcome {
  const read = findKnownRead(req.method, req.hostname, req.path, req.body);
  if (read === undefined) throw new Error(`crashtest: ${req.method} ${req.hostname}${req.path} is not a known read`);
  return { status: read.status ?? 200, body: read.body(req, state), stateChange: false };
}
