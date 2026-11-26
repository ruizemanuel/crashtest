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

```sh
npm install --save-dev eve-crashtest    # or: pnpm add -D eve-crashtest
```

From a checkout of this repository, run `pnpm install` and then `node packages/engine/src/cli.ts <command>`
(Node runs the TypeScript sources directly).

Nothing calls a real model: the lab replaces the agent's model with a scripted mock, so a run costs no tokens.
No request leaves the lab: every non-loopback HTTP request is answered by the fake provider.

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
| `crashtest badge` | Renders the badge again from a `report.json`. |
| `crashtest fix` | Not available in this version yet. |

`--app <dir>` (every command except `badge`) is the eve app to test; it defaults to the current directory.
`--config <file>` reads the configuration from that file instead of `<app>/crashtest.config.json`; a relative path
is resolved against the current directory. `--name=value` works like `--name value`, and `--help` after any command
prints the usage.

stdout carries only results (the `--json` output or the final summary); progress lines and errors go to stderr.

| Exit code | Meaning |
| --- | --- |
| 0 | Done (for `run` with `--min-stars`: the agent met the bar). |
| 1 | An error (the message starts with `crashtest:`), or the agent rating is below `--min-stars`. |
| 2 | A usage error: unknown option, missing value, missing `--tool`, `--min-stars` outside 1 to 5. Nothing ran. |
| 130 | Interrupted with Ctrl-C (SIGINT). Every `eve dev` that crashtest started is killed first. |

### `crashtest plan`

```
crashtest plan [--app <dir>] [--config <file>] [--json]
```

Creates the lab, applies the overlay and asks `eve info` for the tools, then removes the lab. It prints the eve
version, the tools that would run, the tools that are skipped and why, and an estimate. `--json` prints:

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

Not available in this version yet. It will propose a fix for a tool that runs twice and re-run the tool's lane
on the patched lab.

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
   `agent/hooks/crashtest_probe.ts` and, when the app has `agent/channels/eve.ts`, a lab channel with local
   development auth. Tool files are never changed.
3. **Preload.** Every eve process in the lab runs with a preload (`NODE_OPTIONS=--import`). It answers every
   non-loopback HTTP request as a fake provider, writes each request, and each file write the app makes inside the
   lab, to the run's ledger and kills the process at the cell's crash point. Environment variables that look like
   credentials (names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL` or `COOKIE`, and names
   starting with `VERCEL_`, `AI_GATEWAY_`, `ANTHROPIC_` or `OPENAI_`) are removed from the lab's environment, and
   eve's telemetry is turned off.
4. **Discovery.** `eve info --json` lists the tools and their input schemas. The tools under test are the files
   at the top level of `agent/tools/` (without `*.spec.*` and `*.test.*`); eve's built-in tools are not tested. An
   authored tool that eve does not list is reported as not evaluated.
5. **Input.** Each tool is called with one input, generated deterministically from its input schema or taken from
   `scenarios.<tool>.input` in the configuration.
6. **Lanes.** Each tool runs through the cells below; then its verdicts become stars.

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
with the same body is benign. On every host, a repeat with the same `Idempotency-Key` (or `X-Idempotency-Key`)
header and the same body counts once, as with providers that honor the header.

## Star ratings

| Stars | The tool, across the crash cells |
| --- | --- |
| ★★★★★ 5 | Made exactly one state change in every cell, and the model always got a truthful result: a success, or an explicit uncertain-outcome error such as `OUTCOME_UNKNOWN`. |
| ★★★★☆ 4 | Never ran twice, but in some cell the model got a misleading result: an error although the effect happened, or a success although no effect reached the provider. |
| ★★★☆☆ 3 | Ran twice only when the call came back with a new id (fresh id or a retry by the model): its protection is tied to `ctx.callId`. |
| ★★☆☆☆ 2 | Ran twice when the step was replayed with the same call id, but the tool requires approval. |
| ★☆☆☆☆ 1 | Ran twice when the step was replayed with the same call id, and the tool requires no approval. |
| not evaluated | No external effect in the baseline, the baseline failed, the two baselines differed, a crash cell could not be evaluated, or eve did not list the tool. |

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
  "tools": { "exclude": ["legacy_sync"] }
}
```

| Key | Shape | What it does |
| --- | --- | --- |
| `scenarios` | `{ "<tool>": { "input"?: object, "freeText"?: string[] } }` | `input` replaces the generated input in every cell. `freeText` names the input fields a model may word differently on a replay; the fresh-id and retry cells reword them, and they are never identity fields. By default, string fields named like `text`, `message`, `body`, `note` or `summary` are free text. |
| `identity` | `{ "<tool>": string[] }` | The input fields that identify one business operation (a recipient, an order id). The recommendations name them as the fields to build an idempotency key from. By default: the required scalar fields that are not free text. |
| `env` | `{ "<NAME>": string }` | Environment variables for the lab's eve processes. They are applied after the credential-looking variables are removed, so they always reach the app. Requests never leave the lab, so placeholder values are enough. |
| `fixtures` | `{ "method"?: string, "url": string, "status"?: integer, "body"?: any }[]` | Canned answers of the fake provider, for tools that need a specific response. `url` is matched against the full request URL, where `*` matches any run of characters (including `/`); `method` narrows the match; `status` defaults to 200 and `body` to `{}`. The first matching fixture answers. A mutating request answered by a fixture counts as a state change. |
| `effects.ignore` | `string[]` | Request URLs, or lab-relative file paths such as `data/cache/*`, that are not effects of the tool, with the same `*` rule, matched against the full URL or path. |
| `waivers` | `{ "<tool>": string }` | The tool is still tested and rated, and the report shows the reason, but the agent rating leaves it out. |
| `tools.exclude` | `string[]` | Tools that are not run. `plan` lists them as skipped; the report leaves them out entirely (they do not count in "N of M tools evaluated"). |

## Limits

- crashtest observes HTTP/1.1 requests made through `fetch`, `node:http` and `node:https`, and the file writes the
  app makes inside the lab with `node:fs`: `writeFileSync`, `appendFileSync`, `writeFile`, `appendFile` and the
  `fs.promises` forms of `writeFile` and `appendFile`. Files under `.eve`, `node_modules` or a `.crashtest*`
  directory at the top of the lab are not effects. It does not observe raw TCP (Postgres, Redis, SMTP), HTTP/2,
  gRPC, effects inside eve sandboxes, writes outside the lab, writes from child processes that are not Node (a Node
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
