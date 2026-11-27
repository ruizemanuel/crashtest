# eve-crashtest

Crash-test ratings for eve agents. `crashtest` copies an eve app into a disposable lab, kills `eve dev` with
SIGKILL at the moments that matter during a tool call, resumes it, and counts the external effects that reached a
fake provider. Every authored tool gets a star rating with the evidence behind it; the app gets a Markdown report,
a JSON report and a badge.

eve's recovery does not make external effects exactly-once: a step that crashes after a tool sent an email or
issued a refund can run again on resume, and the replayed call looks clean in eve's own event stream. crashtest
makes those repeats visible, tool by tool.

**Results describe the lab run, not production.** A rating says what happened in these crash cells, with these
inputs, the eve version installed in the app and a fake provider. It says nothing about crashes, inputs or
providers the lab does not model (see [Limits](#limits)).

## Install

Requirements: Node.js 24.2 or later, on Linux or macOS (Windows works for development), and an eve app with its
dependencies installed. crashtest has no eve dependency of its own: it drives the eve that the app has installed.
It needs eve 1.2.0 or later (tested on 1.2.0 and 1.5.0): older versions lack `mockModel` in `eve/evals` and `eve dev --resume`,
and crashtest refuses them with a message that says which version is installed.

```sh
npm install --save-dev eve-crashtest    # or: pnpm add -D eve-crashtest
```

From a checkout of this repository, run `pnpm install` and then `node packages/engine/src/cli.ts <command>`
(Node runs the TypeScript sources directly).

Nothing calls a real model: the lab replaces the agent's model with a scripted mock, so a run costs no tokens.
No HTTP request leaves the lab: every non-loopback HTTP/1.1 request (`fetch`, `node:http`, `node:https`) is answered
by the fake provider. **Connections that are not HTTP/1.1 are neither faked nor blocked: they reach their real
servers.** That covers database drivers (Postgres, MySQL, MongoDB), Redis, SMTP, HTTP/2, gRPC and raw sockets. The
lab's environment drops credentials and the URLs of databases, caches, queues and mail servers (see
[How a run works](#how-a-run-works)), so such a tool usually finds no server to connect to; an address that the
configuration's `env` sets is used for real.

## Quick start

```sh
cd my-eve-app
npx crashtest plan     # which tools would run, without starting eve dev
npx crashtest run      # crash-test every tool and write .crashtest/report.md
```

In CI, after the app's dependencies are installed, fail the job when the agent rating is below a bar:

```sh
npx crashtest run --min-stars 4
```

## Commands

| Command | What it does |
| --- | --- |
| `crashtest plan` | Discovers the tools and prints the plan. Never starts `eve dev`. |
| `crashtest lane --tool <name>` | Crash-tests one tool and prints its rating. Writes no report files. |
| `crashtest run` | Crash-tests every tool and writes the report and the badge. |
| `crashtest fix --tool <name>` | Proposes a patch for a tool that runs twice and re-runs its lane on a patched lab copy. |
| `crashtest badge` | Renders the badge again from a `report.json`. |

`--app <dir>` (every command except `badge`) is the eve app to test; it defaults to the current directory.
`--config <file>` reads the configuration from that file instead of `<app>/crashtest.config.json`; a relative path
is resolved against the current directory. `--name=value` works like `--name value`, and `--help` after any command
prints the usage.

stdout carries only results (the `--json` output or the final summary); progress lines and errors go to stderr.

| Exit code | Meaning |
| --- | --- |
| 0 | Done (for `run` with `--min-stars`: the agent met the bar; for `fix`: also when no candidate improved a tool). |
| 1 | An error (the message starts with `crashtest:`), or the agent rating is below `--min-stars`. |
| 2 | A usage error: unknown option, missing value, missing `--tool` (for `fix`: neither or both of `--tool` and `--all`), `--min-stars` outside 1 to 5. Nothing ran. |
| 130, 143, 129 | Interrupted by SIGINT (Ctrl-C), SIGTERM (a CI cancel, `timeout`) or SIGHUP (a closed terminal): 128 plus the signal number. Every `eve dev` that crashtest started is killed first. |

### `crashtest plan`

```
crashtest plan [--app <dir>] [--config <file>] [--json]
```

Creates the lab, applies the overlay and asks `eve info` for the tools, then removes the lab. It prints the eve
version, the tools that would run, the tools that are skipped and why, and an estimate. Files in `agent/tools/` that only
call `disableTool()` are not counted as tools. `--json` prints:

```json
{
  "eve": { "version": "1.5.0", "capabilities": { "replayNever": false } },
  "tools": [{ "name": "send_message", "cells": ["baseline-1", "baseline-2", "post-effect-fast-stable", "post-effect-fast-fresh", "post-effect-slow", "post-settle"] }],
  "skipped": [{ "name": "legacy_tool", "reason": "excluded by config" }],
  "estimatedSeconds": 90
}
```

The estimate is 15 seconds for every planned cell, one run each. Retries and confirmation runs come on top.

### `crashtest lane --tool <name>`

```
crashtest lane --tool <name> [--app <dir>] [--config <file>] [--json] [--keep-lab]
```

Runs the lane of one tool: the two baselines and the four crash cells, with retries and confirmation runs. It
prints one line such as `send_message: ★☆☆☆☆ (1/5) · In lab: 10 cells · eve 1.5.0`; with `--json` it prints the
whole lane result instead (the rating with every cell's verdict, the number of runs and the wall time). A tool
that crashtest did not find, or one that it skips, is an error. The evidence stays in `.crashtest/runs/<tool>/`.

### `crashtest run`

```
crashtest run [--app <dir>] [--config <file>] [--tools <a,b>] [--install] [--keep-lab] [--min-stars <1-5>]
```

Runs the lane of every tool, then writes `.crashtest/report.json`, `.crashtest/report.md` and
`.crashtest/badge.svg`. stdout gets the path of the Markdown report and the agent rating line:

```
Report: /path/to/my-eve-app/.crashtest/report.md
Agent rating: ★☆☆☆☆ (1/5) · 1 of 2 tools evaluated · In lab: 12 cells · eve 1.5.0 · commit 1a2b3c4
```

- `--tools a,b` runs only the listed tools, and the report covers only them. A name that crashtest did not find is
  an error that lists the tools it did find.
- `--install` first installs the app's dependencies from its lockfile (`pnpm install --frozen-lockfile`, `npm ci`,
  `yarn install` with the frozen or immutable flag, or `bun install --frozen-lockfile`). The app needs a lockfile.
- `--min-stars <n>` makes the command exit with 1 when the agent rating is below `n`. An agent that was not
  evaluated counts as below. The report is written either way.

### `crashtest badge`

```
crashtest badge [--report <file>] [--out <file>]
```

Renders the badge again from a report. `--report` defaults to `.crashtest/report.json` in the current directory,
`--out` to `badge.svg` next to the report. It prints the path of the badge.

### `crashtest fix`

```
crashtest fix (--tool <name> | --all) [--identity <a,b>] [--report <file>] [--apply] [--app <dir>] [--config <file>]
```

Proposes a patch for a tool that a crash makes run twice, and judges it the way the tool was judged: by running
its lane again, this time on a patched lab copy of the app. The app's files change only with `--apply`.

1. **Before.** The tool's rating comes from a fresh lane, or from `--report <file>` when that report describes the
   code the app has now: it was made at the commit the app is at, without uncommitted changes (its `target.dirty`
   is false), and the app has no uncommitted changes now (changes under `.crashtest/` do not count). Otherwise the
   report is ignored, with one line on stderr that says why, and every tool is rated with a fresh lane. The report
   is read once, before any tool is fixed, so `--apply` on one tool does not make it unusable for the next. A tool
   rated ★★★★★ or not evaluated gets no candidates.
2. **Candidates.** Each strategy is a codemod applied to its own lab copy, `.crashtest/lab-fix-<strategy>`, which
   is then overlaid and discovered like any lab; the tool's lane runs on it, and the lab is removed afterwards. Both
   codemods add the helper `agent/lib/crashtest-idempotency.ts` (unless the app already has that file) and build
   an op-key from the session id, the turn id, the tool name and the identity fields, never from `ctx.callId` or
   free text. The identity fields are `--identity a,b`, else `identity.<tool>` from the configuration, else the
   defaults described under [Configuration](#configuration).
   - `upstream-key` sends the op-key as the `Idempotency-Key` header of the tool's request to a host that honors
     the header (Stripe and Resend in the fake provider's catalog). It applies only when `execute` makes exactly
     one such `fetch` call, outside any loop or callback.
   - `ledger-guard` wraps the body of `execute` in `once(opKey(ctx, { ... }), defaultStore(), async () => { ... })`.
     A replay after the effect finished gets the stored result; a replay after a crash during the effect gets an
     `OUTCOME_UNKNOWN` error that tells the model to check before retrying, instead of a second effect. When the
     effect happened but its result cannot be stored, the call still returns the result and logs a warning, and a
     replay gets `OUTCOME_UNKNOWN`.

   A codemod that does not apply to the tool's code says why in `<tool>.json`, and its candidate runs no lane.
   `ledger-guard` does not wrap a synchronous `execute` that declares its return type, which the guard would turn
   into a Promise. Neither codemod adds an identity field to a destructured input whose type annotation does not
   declare it; only a type literal such as `{ to: string; orderId: string }` shows that it does. When the app has
   a `tsconfig.json`, a patch that would add type errors to the project is not applied; the reason names the first
   one. Errors about a module or a type package that cannot be found do not count: what is installed is not the
   patch's doing. When the type check cannot run, for example because the `tsconfig.json` has a syntax error or
   its `extends` does not resolve from the lab copy (which sits two directories below the app), the patch is not
   applied either, and the reason says why. The helper import gets the extension of the tool's other relative
   imports (`.ts` or `.js`); a tool without any gets `.js` when the tsconfig sets `module` to `node16`, `node18`,
   `node20` or `nodenext`, or `moduleResolution` to `node16` or `nodenext` (`.ts` with
   `allowImportingTsExtensions`), and no extension otherwise.
3. **Choice.** A candidate improves the tool when its rating has more stars than before and no crash cell got a
   worse verdict, from best to worst: `clean`; `phantom-failure` and `lost-effect`; `dup`; `invalid`. Of the
   improving candidates the one with the most stars is chosen, and on a tie the earlier strategy (`upstream-key`
   comes first).

For each tool, stdout gets one result:

```
In lab: send_message ★☆☆☆☆ → ★★★★★ with ledger-guard (14 runs, eve 1.5.0). Patch: .crashtest/fix/send_message.patch
Trade-off: a second legitimate call with the same identity (to, orderId) in the same turn is blocked.
Store: the lab used the file store, which is for local runs only and keeps its records in .crashtest-idempotency/ in the working directory of eve dev (the app root); add that directory to .gitignore.
Production requires a durable store: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (Upstash Redis REST).
```

The runs are those of the chosen candidate's lane. The extra lines appear only for `ledger-guard`:

- **Trade-off.** The op-key does not change within a turn, so a second call of the tool with the same identity
  in the same turn gets the first call's stored result instead of running. Name identity fields that tell two
  legitimate operations apart.
- **Store.** With `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set, `defaultStore()` uses Upstash Redis
  over REST, a durable store that every instance and every deployment of the app shares. **Production requires
  it.** Without them it falls back to the file store, which is for local runs only: one JSON file per operation in
  `.crashtest-idempotency/` in the working directory of `eve dev` (the app root, unless `CRASHTEST_IDEMPOTENCY_DIR`
  names another directory). Add `.crashtest-idempotency/` to the app's `.gitignore`: the records are run state, not
  code, and while the directory is untracked the app reads as having uncommitted changes, so `fix --report` ignores
  the report. The lab ran with the file store: it removes `UPSTASH_REDIS_REST_TOKEN` with the other
  credential-looking variables (unless `env` in the configuration sets it).

When no candidate improves the tool, it prints `No candidate improved <tool>; nothing written.` and no patch is
written. A tool that gets no candidates prints `No fix needed for <tool>: ★★★★★ (5/5) in lab.` or
`No fix attempted for <tool>: not evaluated (<reason>).`

- `--tool <name>` fixes one tool; `--all` fixes every tool that crashtest finds and that is rated 1 to 4 stars.
- `--identity a,b` sets the identity fields of the op-key; it goes with `--tool`.
- `--report <file>` takes the before ratings from a `report.json` (see above); a tool that the report does not
  cover gets a fresh lane.
- `--apply` writes the chosen patch into the app, right after that tool's result (so with `--all` each later tool
  starts from the patched app) and prints `Applied:` with the files. Every file must still be what the fix was made
  from, and a file the fix creates must not exist yet; otherwise nothing is written and the command fails.

The outputs go to `.crashtest/fix/`:

- `<tool>.patch` is a unified diff of the chosen candidate (`a/<path>` to `b/<path>`, a new file from `/dev/null`).
  Apply it with `git apply .crashtest/fix/<tool>.patch`. Patches of different tools each create the helper, so
  apply one and fix the next tool from there, or use `--apply`.
- `<tool>.json` is the outcome: the identity fields, the before rating, every candidate (whether it applied, why
  not, its rating, its files, its runs and the eve version of its lab) and the chosen one. It is written whenever
  candidates ran.

Every lane writes its runs to `.crashtest/runs/<tool>/`, so after `fix` that directory holds the runs of the last
lane that ran; a run directory that lane did not make can be left over from an earlier lane.

### `--keep-lab`

`lane` and `run` remove the lab when they end. With `--keep-lab` it stays in `.crashtest/lab` for inspection; the
next command replaces it.

## Output

```
.crashtest/
  report.json                     the report (schemaVersion 1)
  report.md                       the same report in Markdown, ready for a pull request comment
  badge.svg                       the rating badge
  runs/<tool>/<cell>-a<attempt>/  evidence of every run: summary.json, ledger.jsonl, dev1.log, dev2.log (after
                                  the restart), provider-state.json, script.json
  runs/_discover/                 the discovery run
  lab/                            the lab copy, while a command runs (or after --keep-lab)
  fix/<tool>.patch                the patch that crashtest fix chose for the tool
  fix/<tool>.json                 the outcome of crashtest fix for the tool, with every candidate
  lab-fix-<strategy>/             the patched lab copy of a fix candidate, while the candidate is tried
```

crashtest writes `.crashtest/.gitignore`, which ignores `lab/`, `lab-*/` and `runs/`, so the report and the badge
can be committed.

## How a run works

1. **Lab.** crashtest copies the app into `<app>/.crashtest/lab`: the files git tracks or would show as
   untracked (so `.gitignore` applies), or every file when the app is not in a git work tree. It never copies
   `node_modules`, `.git`, `.eve`, `.crashtest`, `.vercel` or any file whose name starts with `.env`. The lab lives
   inside the app so Node finds the app's own `node_modules`. The app's files are never modified.
2. **Overlay.** In the lab, `agent/agent.ts` is renamed to `agent/agent.ctorig.spec.ts` and wrapped by a shim that
   keeps the agent as defined but replaces its model with a scripted `mockModel`. crashtest adds the hook
   `agent/hooks/crashtest_probe.ts` and the lab channel `agent/channels/eve.ts` (the app's own, if any, is renamed
   to `agent/channels/eve.ctorig.spec.ts`). The lab channel accepts only local callers and gives each session the
   caller identity that the configuration sets for the tool (`auth`), else eve's local development caller. Tool
   files are never changed.
3. **Preload.** Every eve process in the lab runs with a preload (`NODE_OPTIONS=--import`). It answers every
   non-loopback HTTP request as a fake provider, writes each request, and each file write the app makes inside the
   lab, to the run's ledger and kills the process at the cell's crash point. Environment variables that look like
   credentials (names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `COOKIE`, and names
   starting with `VERCEL_`, `AI_GATEWAY_`, `ANTHROPIC_` or `OPENAI_`) are removed from the lab's environment. So is
   every variable, whatever its name, whose value carries URL credentials (`scheme://user:pass@host`) or the URL of
   a database, cache, queue or mail server (`postgres://`, `postgresql://`, `mysql://`, `mariadb://`, `mssql://`,
   `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`, `amqp://`, `amqps://`, `nats://`, `kafka://`,
   `smtp://` and similar), because the preload does not fake those connections. A variable that `env` in the
   configuration sets reaches the lab as given. eve's telemetry is turned off.
4. **Discovery.** `eve info --json` lists the tools and their input schemas. The tools under test are the files
   at the top level of `agent/tools/` (without `*.spec.*` and `*.test.*`); eve's built-in tools are not tested. An
   authored tool that eve does not list is reported as not evaluated.
5. **Input.** Each tool is called with one input, generated deterministically from its input schema or taken from
   `scenarios.<tool>.input` in the configuration.
6. **Lanes.** Each tool runs through the cells below; then its verdicts become stars. When a baseline run fails, the
   tool is not evaluated and the reason ends with the likely fix. When the tool's own error mentions authorization
   or authentication, says unauthorized, forbidden, permission denied, not allowed or sign in, or mentions the
   session, a context, 401 or 403, the reason points at `auth` or `scenarios.<tool>.auth`, which give the lab session
   the identity the tool checks. Otherwise, when the tool's own error is about an invalid, expected or required
   value, a validation, a schema or what a value must be, it points at `scenarios.<tool>.input`. Anything else,
   including every failure crashtest reports itself (a server that did not start, a turn that did not complete),
   points at the run directory and the keys that can help: `scenarios.<tool>.input`, `auth`, `env` and `fixtures`.

## Cells

A cell is one `eve dev` life with one crash point. crashtest starts the server, sends one message, and the
scripted model calls the tool under test once. When the server dies at the crash point, crashtest restarts it with
`eve dev --resume`, approves whatever the turn asks for, and waits up to 120 seconds for the turn to settle. Then
it compares the ledger with the baselines. A lane runs these six cells:

| Cell | Crash point | What it shows |
| --- | --- | --- |
| `baseline-1`, `baseline-2` | none | The effects of a run without a crash. Two runs show which request fields change from run to run. |
| `post-effect-fast-stable` | right after the request reaches the provider | eve replays the step and the call keeps its id, as an approved call does. A tool that needs approval shows this cell as `approved-post-effect`. |
| `post-effect-fast-fresh` | right after the request reaches the provider | The replayed call gets a new id and reworded free text, as when a real model issues the call again. |
| `post-effect-slow` | the provider holds the request for 2 s, then the crash | eve reports the call as interrupted and the model calls the tool again. |
| `post-settle` | right after eve records the call as settled, with 2.5 s of provider latency | The window between the end of the call and eve's checkpoint. |

Each cell gets a verdict: `clean`, `dup` (more state changes than in the baseline), `phantom-failure` (the effect
happened once but the model got an error), `lost-effect` (the model got a success but no effect reached the
provider) or `invalid` (the run says nothing about the tool, for example because the crash point was never
reached). An invalid cell is run once more. Any other verdict than `clean` has to show up in 2 of 3 runs to count.

An effect is a mutating request (any method but GET, HEAD and OPTIONS) that reaches the fake provider, even when
the crash came before the answer: a real provider could have processed it. A file write inside the lab is an effect
too, counted per file (`WRITE data/state.json`, `APPEND data/outbox.jsonl`): an append always changes state, and a
write that puts in a file the content it already has is a benign repeat. For Stripe, Slack, Resend and GitHub
the fake provider keeps state, so a repeat that changes nothing (adding a label that is already there) is a
benign repeat and does not lower the rating. For other hosts every POST counts, and a PUT, PATCH or DELETE repeated
with the same body is benign.

Some requests are reads that providers receive as POST, which are not effects: the Slack Web API read methods
(`conversations.history`, `conversations.replies`, `conversations.info`, `conversations.list`,
`conversations.members`, `users.info`, `users.list`, `users.lookupByEmail`, `users.conversations`, `auth.test`,
`team.info`, `bots.info`, `chat.getPermalink`, `reactions.get`, `pins.list`, `search.messages` and `files.info`,
sent as GET or POST), the Vercel Connect token exchange (`POST api.vercel.com/v1/connect/token/...`), the GitHub App
installation token (`POST api.github.com/app/installations/<id>/access_tokens`), and a GraphQL query on any host (a
POST to a path that ends in `/graphql` whose `query` document has no `mutation` or `subscription` operation; any
other GraphQL POST is an effect, and so is a document the lab cannot read to its end). They stay in the ledger, but
they are not counted and never trigger a cell's crash point. The fake provider answers them without a state change:
`conversations.history` and `conversations.replies` list the messages posted to the channel, newest first, and a
fixture on one of them is not an effect either. `effects.ignore` still covers any other request that is not an effect
of the tool.

A repeat with the same `Idempotency-Key` (or `X-Idempotency-Key`) header and the same body counts once where the
real service honors the header: Stripe and Resend (the same key with another body gets their conflict error). Slack
and GitHub ignore the header, so there a repeat with the same key is a second effect. For a host outside the
catalog the header is assumed to be honored, since the lab cannot know; a 5-star summary that rests on such a repeat
names the host and says the key is assumed to be honored.

## Star ratings

| Stars | The tool, across the crash cells |
| --- | --- |
| ★★★★★ 5 | Made exactly one state change in every cell, and the model always got a truthful result: a success, or an explicit uncertain-outcome error such as `OUTCOME_UNKNOWN`. |
| ★★★★☆ 4 | Never ran twice, but in some cell the model got a misleading result: an error although the effect happened, or a success although no effect reached the provider. |
| ★★★☆☆ 3 | Ran twice only when the call came back with a new id (fresh id or a retry by the model): its protection is tied to `ctx.callId`. |
| ★★☆☆☆ 2 | Ran twice when the step was replayed with the same call id, but the tool requires approval. |
| ★☆☆☆☆ 1 | Ran twice when the step was replayed with the same call id, and the tool requires no approval. |
| not evaluated | No external effect in the baseline, the baseline failed, the two baselines differed, a crash cell could not be evaluated and the other cells do not settle the rating (see below), or eve did not list the tool. |

A crash cell that could not be evaluated makes the tool not evaluated, unless the cells that could be evaluated
settle the rating whatever that cell would have shown. A duplicate with the same call id gives 1 or 2 stars in any
case. A duplicate with a new id or after a retry gives 3 stars when both cells that keep the call id
(`post-effect-fast-stable` and `post-settle`) could be evaluated, since only they can show a duplicate with the same
call id. The summary then names the cells that could not be evaluated.

"Not evaluated" never counts as a pass. The agent rating is the lowest rating among the evaluated tools that are
not waived, shown with its coverage ("1 of 2 tools evaluated"). With no such tool, the agent is not evaluated.

## Configuration

crashtest reads `crashtest.config.json` from the app directory, or the file given with `--config`. The file is
optional and every key in it is optional. Unknown keys and wrongly typed values are errors, because a typo would
silently weaken the test.

```json
{
  "scenarios": {
    "send_message": { "input": { "to": "alice", "orderId": "ord_1", "text": "Your order shipped." }, "freeText": ["text"] }
  },
  "identity": { "send_message": ["to", "orderId"] },
  "env": { "ACME_API_URL": "https://api.acme.test" },
  "fixtures": [{ "method": "GET", "url": "https://api.acme.test/v1/orders/*", "status": 200, "body": { "status": "paid" } }],
  "effects": { "ignore": ["https://telemetry.acme.test/*"] },
  "waivers": { "post_note": "Internal notes; a duplicate is harmless." },
  "tools": { "exclude": ["legacy_sync"] },
  "auth": { "authenticator": "slack-webhook", "principalType": "user", "principalId": "U0CRASHTEST", "attributes": { "team_id": "T0CRASHTEST" } }
}
```

| Key | Shape | What it does |
| --- | --- | --- |
| `scenarios` | `{ "<tool>": { "input"?: object, "freeText"?: string[], "auth"?: object } }` | `input` replaces the generated input in every cell. `freeText` names the input fields a model may word differently on a replay; the fresh-id and retry cells reword them, and they are never identity fields. By default, string fields named like `text`, `message`, `body`, `note` or `summary` are free text. `auth` is the session identity of this tool's cells (see `auth`). |
| `identity` | `{ "<tool>": string[] }` | The input fields that identify one business operation (a recipient, an order id). The recommendations name them as the fields to build an idempotency key from. By default: the required scalar fields that are not free text. |
| `env` | `{ "<NAME>": string }` | Environment variables for the lab's eve processes. They are applied after the credential-looking variables and the connection URLs are removed, so they always reach the app as given, even a value that the scrub would drop. HTTP requests never leave the lab, so placeholder values are enough; but a database URL, or any other address of a server that is not HTTP, set here is connected to for real. |
| `fixtures` | `{ "method"?: string, "url": string, "status"?: integer, "body"?: any }[]` | Canned answers of the fake provider, for tools that need a specific response. `url` is matched against the full request URL, where `*` matches any run of characters (including `/`); `method` narrows the match; `status` defaults to 200 and `body` to `{}`. The first matching fixture answers. A mutating request answered by a fixture counts as a state change. |
| `effects.ignore` | `string[]` | Request URLs, or lab-relative file paths such as `data/cache/*`, that are not effects of the tool, with the same `*` rule, matched against the full URL as the ledger records it (secrets in the query or path redacted) or the path. An ignored request or write stays in the ledger, but it is not counted and never triggers a cell's crash point: the crash comes after the next effect that is not ignored. |
| `waivers` | `{ "<tool>": string }` | The tool is still tested and rated, and the report shows the reason, but the agent rating leaves it out. |
| `tools.exclude` | `string[]` | Tools that are not run. `plan` lists them as skipped; the report leaves them out entirely (they do not count in "N of M tools evaluated"). |
| `auth`, `scenarios.<tool>.auth` | `{ "authenticator": string, "principalId": string, "principalType": string, "attributes"?: { "<name>": string \| string[] }, "issuer"?: string, "subject"?: string }` | The caller identity the lab session gets, as a tool reads it from `ctx.session.auth.current`, for tools that check who is calling (a Slack team, a GitHub installation). `scenarios.<tool>.auth` applies to that tool and wins over the top-level `auth`. The first three fields must be non-empty; `attributes` defaults to `{}`. Without either key, the session gets eve's local development caller. Whatever the identity, the lab channel accepts only local callers. |

## Limits

- crashtest observes HTTP/1.1 requests made through `fetch`, `node:http` and `node:https`, and the file writes the
  app makes inside the lab with `node:fs`: `writeFileSync`, `appendFileSync`, `writeFile`, `appendFile` and the
  `fs.promises` forms of `writeFile` and `appendFile`. Files under `.eve`, `node_modules` or a `.crashtest*`
  directory at the top of the lab are not effects. It neither observes nor blocks raw TCP (Postgres, Redis, SMTP),
  HTTP/2 or gRPC: those connections reach their real servers when the app has an address for them. It does not
  observe effects inside eve sandboxes, writes outside the lab, writes from child processes that are not Node (a Node
  child process inherits the preload and is observed), or file changes made through other APIs: a file descriptor
  (`fs.write`), a stream (`createWriteStream`), an `fs.promises` file handle, `rename`, `copyFile`, `rm` and so on.
  A tool whose only effect is one of these shows as not evaluated (no external effect in the baseline).
- For a file write, the 2 s hold of `post-effect-slow` stops the whole process, not just the call, so eve cannot mark
  the call as interrupted: that cell shows a replay with a new call id, like `post-effect-fast-fresh`, instead of a
  model retry.
- Each cell starts from the prepared lab files. After a cell, every file the preload recorded as written is put
  back: copied from the app when the app has that file, removed (with the directories that this leaves empty)
  otherwise. Files changed in ways crashtest does not observe, and everything under `.eve`, `node_modules` and
  `.crashtest*`, are not restored.
- Only the six cells above run. A crash before the effect, while an approval is pending, a second crash during
  recovery, or a crash after every event are not tested.
- Each tool is tested with one input and one call per turn; multi-step scenarios are not supported.
- The model is a scripted mock. The fresh-id and retry cells imitate how a real model issues a call again after a
  crash; how often a real model actually retries is not measured.
- Only authored tools in `agent/tools/` are tested: tools from MCP or OpenAPI connections, from extensions, or
  added at runtime are not.
- Every approval is approved.
- Hosts outside the fake provider's catalog get a generic success answer; a tool that needs a specific response
  needs a fixture.
- A report covers one eve version (the one installed in the app) and one platform and Node version, both recorded
  in `report.json`.
