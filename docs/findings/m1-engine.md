# M1 engine findings

Summary (2026-11-26; engine at commit `809f68e`, whose engine code equals `ccd4016` because `809f68e` only adds CI;
Windows 10, Node 24.15.0; every run used the scripted mock model, so no tokens were spent and no AI Gateway key was
used):
- **The replay assumptions hold** with eve 1.5.0: in the stable cell both effects carry the same call id
  (`mock-tool-call-1-0-1-1`), and the post-effect-slow retry runs in the same turn (`turn_0`), in 6 of 6 runs of
  each cell.
- **The zoo rates every tool as designed**: 10 tools, 1 to 5 stars plus one not evaluated, 73 runs, 929.8 s of
  lane time on one machine.
- **Framework startup creates no effects**: across 75 zoo run directories and the discovery run (259 ledger
  entries) every entry that a tool did not make is eve's non-mutating model-catalog GET; eve's own file writes stay
  under `.eve/` and `node_modules/.cache/eve/`. The same held for both real templates.
- **No tool of the real templates can be rated yet.** `watch_slack_channel` and `apply_labels` stop at an
  authorization check that needs a channel session (Slack or GitHub) the lab cannot create;
  `evidence_record` only changes eve session state. The pull-request triage template locks eve 0.7.4, which
  crashtest cannot drive, and its source does not compile on eve 1.5.0 without changes.
- **S5 exposed engine gaps** (recorded as blockers below, not fixed in M1): reads sent as POST count as effects (a
  read-only Slack tool rated 1 star), `disableTool()` files count as authored tools, an unsupported eve version
  fails with a module-resolution error, and the baseline-failed hint always points at the input.
- **eve 1.2.0** has every capability the engine uses; a full lane ran on it (the SRE template).

## Engine verification

### Call id and turn id across a replay

Cell `naive` (zoo), eve 1.5.0. Sources: the cell-runner e2e suite (`test/e2e/run-cell.test.ts`), run 3 times and
once more after its fix round, and attempts a1 and a2 of the full zoo run. The engine's e2e test asserts both facts
on non-empty values, so a missing id cannot compare equal to another missing id.

| Cell | Runs | Effects (callId@turnId) | Holds? |
|---|---|---|---|
| post-effect-fast-stable | 6 | `mock-tool-call-1-0-1-1@turn_0` twice in every run | same call id, 6 of 6 |
| post-effect-slow | 6 | `ct-call-1-<pid>@turn_0`, then `ct-call-2-<pid>@turn_0`; call 1 `abandoned`, call 2 `completed` | same turn id, 6 of 6 |
| post-effect-fast-fresh | 6 | `ct-call-1-<pid>`, then `ct-call-2-<pid>` with text `crashtest text (rewritten 2)`, same `orderId` | new id and new text by design |

`turn_0` is a position inside a session, not a global id; the op-key also hashes the session id (unique per cell),
so keys never collide across cells. In the fresh cell eve's stream shows only the replayed call, so the first
effect is invisible in the stream, as in M0 spike S1.

### Framework startup creates no HTTP or file effects

- The 75 run directories under `packages/engine/test/fixtures/zoo/.crashtest/runs/` (the full zoo run plus two
  run-cell e2e cells, all at the `ccd4016` code) and the discovery run hold 259 ledger entries. Every mutating entry
  is the tool's own endpoint. Every other entry is `GET ai-gateway.vercel.sh/v1/models/catalog` (non-mutating; one per `eve dev`
  start, so 1 in a baseline and 2 in a crash cell) or a read made by the tool itself.
- `readonly` baselines: 0 effects (2 of 2). Discovery (`runs/_discover/ledger.jsonl`): only the catalog GET.
- File writes by eve itself, measured with every exclusion turned off for one baseline: about 40 files, all under
  `.eve/` (compiler output, workflow data, dev-runtime snapshots, traces, cleanup intents) or
  `node_modules/.cache/eve/` (bundled authored modules, leases, workflow-driver maps). Both are excluded. With the
  exclusions off, the first lease write was a mutating effect and fired `post-effect-fast` at startup, before the
  tool ran.
- Real templates: in the 6 baselines of `watch_slack_channel`, `evidence_record` (SRE template on eve 1.2.0, with an
  extension, two connections and three channels) and `apply_labels` (triage template on eve 1.5.0), and in both
  discovery runs, the ledger holds only the catalog GET: the extension, the connections and the channels made no
  request at startup.

### Auto-approve

- `approval_naive` (zoo, `approval: always()`, eve 1.5.0): `approvals: 1` in all 8 of its runs, every turn
  `completed`. Its stable cell is shown as `approved-post-effect` and reproduced the duplicate 2 of 2 (2 stars).
- In its 6 crash cells the approval given before the crash carried over the restart: eve did not ask again, and the
  count stayed at 1.
- `watch_slack_channel` (SRE template, `approval: always()`, eve 1.2.0): `approvals: 1` in both baselines, turn
  `completed`.

### Zoo star ratings

Full suite `node --test --test-concurrency=1 test/e2e/zoo-stars.test.ts` from `packages/engine`, at `ccd4016`:
10 of 10 pass, 931.4 s in total (lanes 929.8 s, 73 runs). A typical cell takes 6.5 s (baseline), 12.3 s
(post-effect-fast), 14.4 s (post-effect-slow) and 21 s (post-settle, which includes 2.5 s of latency per request).

| Tool | Stars | Runs | Wall s | fast-stable | fast-fresh | slow | post-settle |
|---|---|---|---|---|---|---|---|
| naive | 1 | 10 | 135.2 | dup (stable) | dup (fresh) | dup (retry) | dup (retry) |
| fs_effect | 1 | 10 | 125.4 | dup (stable) | dup (fresh) | dup (fresh) | dup (stable) |
| approval_naive | 2 | 8 | 104.7 | dup (stable) | dup (fresh) | clean (abandoned) | clean (abandoned) |
| callid_guard | 3 | 9 | 121.1 | clean (1 benign: key replay) | dup (fresh) | dup (retry) | dup (retry) |
| phantom_failure | 4 | 10 | 133.7 | phantom-failure | phantom-failure | phantom-failure | phantom-failure |
| opkey_guard | 5 | 6 | 71.4 | clean (uncertain) | clean (uncertain) | clean (uncertain) | clean (success) |
| upstream_key | 5 | 6 | 73.8 | clean (1 benign) | clean (1 benign) | clean (1 benign) | clean (1 benign) |
| benign_labels | 5, benign repeats | 6 | 73.4 | clean (1 benign) | clean (1 benign) | clean (1 benign) | clean (1 benign) |
| check_before_act | 5 | 6 | 78.0 | clean | clean | clean | clean |
| readonly | not evaluated (no effect) | 2 | 13.1 | — | — | — | — |

Every non-clean verdict reproduced 2 of 2 (the third run was not needed). `phantom_failure`'s error in every crash
cell is `Upload failed with status 412` after one `200` state change.

### post-settle recovery mode per tool

The probe hook kills `eve dev` right after eve reports the call as settled; the provider answers after 2.5 s.
"Interrupted" means eve recovered the settled call as `abandoned` and told the model through its framework message
("may or may not have taken effect"); "replayed" means eve ran the step again with the same call id.

| Tool | Runs | Recovery | What followed | State changes | Verdict |
|---|---|---|---|---|---|
| naive | 2 | interrupted | model retried with a new id, completed | 2 | dup (retry) |
| fs_effect | 2 | replayed | same id `mock-tool-call-1-0-1-1` ran again, completed | 2 | dup (stable) |
| approval_naive | 1 | interrupted | no second call; turn completed | 1 | clean (abandoned) |
| callid_guard | 2 | interrupted | retry with a new id passed the call-id guard | 2 | dup (retry) |
| phantom_failure | 2 | interrupted | retry failed with 412 | 1 (+1 refused) | phantom-failure |
| opkey_guard | 1 | interrupted | retry answered from the stored record | 1 | clean (success) |
| upstream_key | 1 | interrupted | retry deduplicated by the idempotency key | 1 (+1 benign) | clean |
| benign_labels | 1 | interrupted | retry added labels already present | 1 (+1 benign) | clean |
| check_before_act | 1 | interrupted | retry found the message and skipped the send | 1 | clean |
| readonly | 1 | interrupted | retry, completed | 0 | not rated (no effect) |
| slack_read_channel_messages (SRE, eve 1.2.0) | 2 | interrupted | retry, completed | 4 | dup (retry), see S5 |

Every HTTP tool was interrupted, so a post-settle duplicate is classified as a retry. The file tool was replayed: a
file write has no provider latency, so the settle falls in the same flush window as the effect, the same timing as
M0 spike S3 with a zero-latency provider.

### Other engine facts learned in M1

1. **eve CLI telemetry.** `eve info` left a detached `eve.js telemetry flush` process whose working directory was
   the lab (on Windows the lab could then not be removed) and that sent its events off the machine, since discovery had
   no preload at the time. During a crash cell the CLI posted its crash report to `telemetry.vercel.com`, which the
   ledger counted as a third effect. The engine sets `EVE_TELEMETRY_DISABLED=1` for `eve info` and for every cell.
2. **Model catalog.** eve requests `GET ai-gateway.vercel.sh/v1/models/catalog` at compile time. Discovery
   (`eve info`) also runs with the preload (run directory `runs/_discover`), so the fake provider answers it and no
   request leaves the machine. Because every ledger holds that GET, effects are counted only from entries that are
   `mutating && stateChange`, never by ledger position.
3. **post-settle is classified as a retry** whenever eve recovers the call as `abandoned` (all HTTP tools above).
4. **File effects.** eve bundles authored tools to `node_modules/.cache/eve/authored-modules/entry-*.mjs` and keeps
   `node:fs` as a native import, so the preload's wrappers see the tool's writes. The 2 s post-effect-slow hold after a
   synchronous write blocks the whole process, so eve cannot mark the call interrupted: the `fs_effect` slow cell is a
   replay with a new id (`dup (fresh)`) instead of a retry. Stars are unaffected. After each cell the engine restores
   the lab files the tool wrote.

## S5 real templates

Both templates were cloned into a scratch directory outside this repository and installed with their lockfile's
package manager. Nothing was posted to either repository, and no real credentials were used.

| Template | Commit | eve installed | Install | `crashtest plan` |
|---|---|---|---|---|
| `vercel-labs/eve-sre-agent-template` | `b2ef701ffd73bee92429287bc210872f3cacf07e` (2026-11-25) | 1.2.0 | `pnpm install --frozen-lockfile` (pnpm 12.21.0, as the lockfile names) | 11 tools, 66 cells, no config needed |
| `vercel-labs/eve-pr-triage-agent-template` | `5f3d0ac62e2d5f84c8557c109bb0cb7aeaee391c` (2026-06-17) | 0.7.4 (lockfile; `package.json` says `latest`) | `npm ci` | fails: `Could not load agent/agent.ctorig.spec` |

### Per tool

| Tool | Template | Config lines | Result | Blocker |
|---|---|---|---|---|
| `watch_slack_channel` | SRE, eve 1.2.0 | 0 | not evaluated: no external effect in the baseline (2 runs, 27.3 s) | needs a Slack session |
| `evidence_record` | SRE, eve 1.2.0 | 0 | not evaluated: no external effect in the baseline (2 runs, 24.7 s) | its only effect is eve session state |
| `apply_labels` | triage, eve 1.5.0 after three source changes | 0 | not evaluated: baseline failed (2 runs, 12.7 s) | needs a GitHub session; does not run on the locked eve |

- **`watch_slack_channel`** requires approval (approved automatically) and then returns
  `{"error": "Authorization denied: not in a Slack context", "success": false}` in both baselines. Its first step,
  `resolveSlackUser(ctx.session.auth.current)`, accepts only a session whose authenticator is `slack-webhook` with a
  user principal and a `team_id`. The lab creates sessions through the eve channel with local development auth, and
  the configuration has no key for the session's auth context, so no configuration of any size gets past this check.
  Behind it the tool would call Slack `conversations.info` (it would need a fixture with `is_member: true`) and write
  the watch record to Vercel Blob.
- **`evidence_record`** completes with `{"status": "recorded", "evidenceId": "evidence-1"}` and makes no request and
  no file write: it stores the finding in eve session state (`defineState`), which eve keeps with the session. That is
  not an external effect, so "not evaluated" is the correct answer; the tool also deduplicates a repeated
  `sourceUrl` + `finding` within a turn. The default input was already valid (`sourceUrl: "https://example.test/r/1"`).
- **`apply_labels`** fails in both baselines with `No GitHub repository on the session. This tool only runs on
  GitHub-triggered turns.` It reads the repository, pull-request number and installation id from the session auth
  attributes that the GitHub channel sets. As with Slack, the lab cannot create such a session. Behind that check it
  would need `GITHUB_APP_ID` and a throwaway RSA `GITHUB_APP_PRIVATE_KEY` to sign its JWT, a fixture for
  `GET /repos/<owner>/<repo>/labels` (the fake provider models only the issue's labels), and `effects.ignore` for the
  installation-token `POST /app/installations/<id>/access_tokens` (blocker 2). Its label write itself is what the fake
  provider's GitHub label set models (adding a label already present is a benign repeat).
- **Triage template versions.** With the locked eve 0.7.4, `eve info` in the lab cannot resolve the overlay's
  extensionless imports (`./agent.ctorig.spec`, `./crashtest_responder.ctgen.spec`; "file not found"). eve 0.7.4
  also lacks what the engine needs: `eve/evals` has no `mockModel`, and `eve dev` has neither `--resume` nor
  `--no-default-extensions`. As the closest working option, a second clone got `npm install eve@1.5.0 ai@7.0.182`
  (eve 1.5.0 is `latest` today, and it needs `ai@^7.0.172`, while the lockfile has `7.0.0-canary.171`). On eve 1.5.0
  the template itself does not compile: `Source "tools/glob.ts" disables a slot with no lower-precedence source.`
  (`glob` and `grep` are opt-in tools in eve 1.5.0), then `Unknown key "markdown"` in `skills/triage.ts` (eve 1.5.0
  names it `content`). Only after deleting `agent/tools/glob.ts` and `agent/tools/grep.ts` and renaming that key did
  `plan` list `apply_labels`. These are changes to the template source, not configuration, and they are outside what
  the lab may do.

### Extra probe: a read-only Slack tool

To see what the engine does with a tool that does reach a provider, `slack_read_channel_messages` (SRE, eve 1.2.0;
it only reads channel history) ran with a 6-line configuration: the input `{"channelId": "C0CRASHTEST", "limit": 20}`
and a fake, unsigned `VERCEL_OIDC_TOKEN` with a far-future expiry (Vercel Connect needs one to resolve the Slack bot
token).

- Result: **1 star in 10 runs, 249.7 s**; all four crash cells `dup`, 2 of 2 each. This rating is wrong for a read.
- Each call makes two POSTs: `POST api.vercel.com/v1/connect/token/slack%2Fsre` (Vercel Connect token exchange) and
  `POST slack.com/api/conversations.history` (eve's `callSlackApi` sends this Web API read as a POST). The
  fake provider knows Slack's history only as a GET and counts any other POST as a state change, so both count as
  effects. The crash point also fired on the token exchange, the first mutating request, before the tool's own call.
- Adding `effects.ignore` for those two URLs (9 lines in total) makes the tool "not evaluated: no external effect", the
  right answer. The progress lines still print "2 effects" for each baseline, because the progress count does not
  apply `effects.ignore`.
- Timing on this template is about twice the zoo's: baselines 12 to 14 s, post-effect cells 24 to 26 s,
  post-settle 39 s (two starts of a larger app: an extension, two connections, three channels).

### Blockers

1. **Session auth cannot be configured.** Every write tool of both templates (`watch_slack_channel`,
   `unwatch_slack_channel`, `create_skill`, `delete_skill`, `apply_labels`) checks the session's channel identity
   before any effect. The lab's sessions come from the eve channel with local development auth. A rating for these
   tools needs a way to start a lab session with a given auth context (authenticator, principal, attributes).
2. **Reads sent as POST count as effects.** Slack Web API reads, the Vercel Connect token exchange and similar
   POST-shaped reads (GraphQL queries, search endpoints) make a read-only tool look like it changes state, and a
   crash cell then reports a duplicate. The workaround is `effects.ignore`. Possible engine fixes: Slack catalog
   entries for the read methods (`conversations.history`, `conversations.info`, `conversations.replies`,
   `users.info`) whatever the HTTP method, and a built-in non-effect entry for the Vercel Connect token endpoint.
3. **`disableTool()` files count as authored tools.** The triage template's `bash.ts`, `read_file.ts` and
   `write_file.ts` only disable framework tools; `plan` reports them as "Skipped: not listed by eve info", and `run`
   on the changed copy lists each as "eve did not list this tool" and prints
   `Agent rating: not evaluated · 0 of 4 tools evaluated` for an app with one real tool.
4. **No minimum eve version.** On eve 0.7.4 the engine fails with an overlay module-resolution error instead of
   saying that the installed eve lacks `mockModel` and `eve dev --resume`.
5. **The baseline-failed hint is generic.** It always adds "set scenarios.<tool>.input in crashtest.config.json",
   also when the failure is an authorization check that no input can pass (`apply_labels`).
6. **The triage template is behind eve.** Its lockfile pins eve 0.7.4, and its source needs three changes to compile
   on eve 1.5.0. This is not an engine problem, but it rules the template out as a demo target until it is updated.

### eve 1.2.0 compatibility

`npm i eve@1.2.0` in an empty scratch project (`--ignore-scripts`; eve 1.2.0 declares no install scripts).

| Question | eve 1.2.0 |
|---|---|
| `eve dev --help` lists `--resume` | yes ("Attempt recovery of retained runs from previous local dev invocations") |
| `eve dev --help` lists `--no-default-extensions` | yes |
| `package.json#exports` has `./evals`, `./hooks`, `./channels/eve`, `./channels/auth`, `./tools/approval` | yes, all five |
| `MockModelToolCall` has `id?` | yes (`readonly id?: string`) |
| `MockModelRequest` has `messages` | yes (`readonly messages: readonly MockModelMessage[]`) |
| interrupted-attempt note wording the scripted model reacts to | same ("interrupted your previous attempt", "may or may not have taken effect") |
| in practice | on the SRE template's eve 1.2.0, `plan`, four baseline-only lanes and one full lane ran: baselines, auto-approve, all four crash points, `eve dev --resume`, the model retry after an interrupted call |

**Decision: FALLBACK** — none of the three real-template tools can be rated in the lab today (two need channel sessions the lab cannot create, one only changes eve session state, and the triage template does not run as published), so the reference agent leads the demo.

## M2 fix verification

The reference agent `examples/acme-support` (six tools, eve 1.5.0) through the demo flow: `crashtest run`, then
`crashtest fix --all --apply --report .crashtest/report.json`, then `crashtest run` again. Source: the e2e test
`acme: 1 star to 5 stars` (`test/e2e/acme.test.ts`), which drives the CLI on a fresh copy of the example at
`examples/acme-support/.crashtest/e2e-copy`. Git ignores that directory, so the first report records commit
`7ac9f32` with a clean tree, `fix` takes its before ratings from that report instead of running new lanes, and the
example itself stays unprotected. Windows 10, Node 24.15.0, scripted mock model and fake provider: no tokens were
spent and no request left the machine. The test ran twice with the same verdicts in every cell; the first run failed
only its last check (see the notes below).

### Before and after

| Tool | Before | Cells before (fast-stable / fast-fresh / slow / post-settle) | Chosen | After | Cells after |
|---|---|---|---|---|---|
| `refund_payment` | 1 | dup (stable) / dup (fresh) / dup (retry) / dup (retry) | upstream-key | 5 | clean (1 benign: key replay) in all four |
| `post_slack_update` | 2 (approval) | dup (stable) / dup (fresh) / clean (abandoned) / clean (abandoned) | ledger-guard | 5 | clean (abandoned) in all four |
| `send_email` | 3 | clean (1 benign: key replay) / dup (fresh) / dup (retry) / dup (retry) | ledger-guard | 5 | clean (uncertain) / clean (uncertain) / clean (uncertain) / clean (success) |
| `upload_receipt` | 4 | phantom-failure in all four (`Upload failed with status 412`) | ledger-guard | 5 | clean (uncertain) / clean (uncertain) / clean (uncertain) / clean (success) |
| `add_ticket_label` | 5, benign repeats | clean (1 benign: label already present) in all four | none | 5 | as before |
| `lookup_order` | not evaluated (no effect) | — | none | not evaluated | — |
| **Agent** | **1**, 5 of 6 tools evaluated | | | **5**, 5 of 6 tools evaluated | |

Every non-clean verdict before the fix reproduced 2 of 2. After the fix the badge reads `★★★★★ eve 1.5.0`.

### Strategy per tool and why

- **`refund_payment`: upstream-key.** Both codemods apply (one `fetch` to Stripe, which honors `Idempotency-Key`)
  and both reach 5 stars in 6 runs. On the tie `fix` keeps the earlier strategy, `upstream-key`, which leaves the
  tool's flow as it is. The key is `opKey(ctx, { chargeId, amount, reason })`. The input has no free text, so every
  attempt in a turn sends the same key with the same body, and the fake Stripe answers the repeat from its stored
  response (a benign repeat in each cell). The ledger-guard candidate's cells were clean (uncertain) three times and
  clean (success) after post-settle.
- **`post_slack_update`: ledger-guard.** Slack honors no idempotency key, so upstream-key does not apply ("no fetch
  call to an idempotency-capable host") and runs no lane. ledger-guard reaches 5 stars in 6 runs, with the approval
  still asked once per run. eve recovered every crash cell of this lane as interrupted (the call ends `abandoned`),
  and the scripted model, as with `approval_naive` in M1, does not issue an interrupted approved call again, so no
  attempt read the guard's record and one post went out per cell. The unprotected tool's call was replayed in the
  two fast cells instead.
- **`send_email`: ledger-guard, because upstream-key reaches only 4 stars.** Both codemods apply. upstream-key
  replaces `Idempotency-Key: ctx.callId` with `opKey(ctx, { to, orderId })` and rated 4 stars in 9 runs. The
  fast-stable cell is clean (same key, same body), but in the fast-fresh, slow and post-settle cells the call that
  comes again has a rewritten `subject` and `body`. Resend then gets the same key with a different body and answers
  409 (`invalid_idempotent_request`); the tool throws on a status that is not 2xx, so the model is told `Email failed
  with status 409` about an email that was sent (phantom-failure, 2 of 2 in each of the three cells). The free-text
  fields cannot go into the key, since they change between attempts, and without them the provider rejects the
  repeat instead of deduplicating it. ledger-guard stops the repeat before the request: 5 stars in 6 runs.
- **`upload_receipt`: ledger-guard.** `files.acme.test` is not an idempotency-capable host, so only ledger-guard
  applies: 5 stars in 6 runs. A call that comes again after a crash during the upload gets `OUTCOME_UNKNOWN`
  (uncertain), and the call after post-settle gets the stored result. No second PUT reaches the provider, so the 412
  that misled the model before never happens.
- **`add_ticket_label` and `lookup_order`** get no candidates: `No fix needed for add_ticket_label: ★★★★★ (5/5) in
  lab.` and `No fix attempted for lookup_order: not evaluated (no-effect).`

**Recovery mode changes with ledger-guard.** In all four ledger-guard lanes (the `refund_payment` candidate
included) eve recovered the two fast cells as interrupted, where it replayed the step for the unprotected tools and
for both upstream-key candidates. The likely cause: the guard awaits its store before it sends the request, so the
call's start has reached eve's stream when the process dies, and eve does not run a call again whose start is in
the recovered stream (eve 1.5.0 docs, "Resuming after a crash"). For the tools without approval the model then
called again, and the guard answered with `OUTCOME_UNKNOWN` (outcome `uncertain`) instead of a second request.

`--apply` wrote each chosen patch into the copy before the next tool: the first applied patch
(`post_slack_update`) created `agent/lib/crashtest-idempotency.ts`, and the later ones only changed their tool file.

### Runs and wall time

| Phase | Runs | Wall time, run 2 (run 1) |
|---|---|---|
| `run` before | 45 (6 lanes) | 586.4 s (584.6 s) |
| `fix --all --apply --report …` | 39 (6 candidate lanes; the 2 codemods that did not apply ran none; no before lanes, thanks to the report) | 504.3 s (516.0 s) |
| `run` after | 32 (6 lanes) | 383.3 s (384.4 s) |
| Whole test | 116 | 1474.1 s, 24.6 min (1485.2 s) |

The candidate lanes of run 2: `refund_payment` upstream-key 6 runs, 74.2 s, and ledger-guard 6 runs, 71.0 s;
`post_slack_update` ledger-guard 6 runs, 78.6 s; `send_email` upstream-key 9 runs, 122.4 s, and ledger-guard 6 runs,
70.8 s; `upload_receipt` ledger-guard 6 runs, 71.7 s. The `fix` wall time also covers discovery for every tool and
for every patched lab. Both runs gave the same verdict in every cell of every lane.

### Notes

- The first run of the test failed only its last check, that the example's own files did not change. The example's
  README had been written into the example while the test ran, after the test had hashed the example. `fix` had
  written its patches into the copy only: the example's tool files were unchanged and it had no `agent/lib/`. The
  second run passed.
