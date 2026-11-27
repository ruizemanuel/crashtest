# M1 engine findings

Summary (2026-11-26; engine at commit `809f68e`, whose engine code equals `ccd4016` because `809f68e` only adds CI;
Windows 10, Node 24.15.0; every run used the scripted mock model, so no tokens were spent and no AI Gateway key was
used):
- **The replay assumptions hold** with eve 1.5.0: in the stable cell both effects carry the same call id
  (`mock-tool-call-1-0-1-1`), and the post-effect-slow retry runs in the same turn (`turn_0`), in 6 of 6 runs of
  each cell.
- **The zoo rates every tool as intended**: 10 tools, 1 to 5 stars plus one not evaluated, 73 runs, 929.8 s of
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

Update (2026-11-27, engine at `8e7ebbc`): the S5 bullets above ("No tool of the real templates can be rated yet",
"S5 exposed engine gaps") are superseded. SRE: `create_skill`, `watch_slack_channel` and `unwatch_slack_channel` get
2 stars (a repeated Vercel Blob write), the other eight tools are not evaluated (no effect). Triage: refused with the
eve version message. Only the gaps "S5 after the engine hardening" lists remain open. The decision there is still
FALLBACK, for a new reason: the three 2-star ratings are repeats that the real store absorbs (engine finding 1).

Update (2026-11-27, engine at `cd994e2`): on the SRE template, `create_skill`, `watch_slack_channel` and
`unwatch_slack_channel` now get 5 stars with benign repeats (Vercel Blob is modeled per object, and the template
overwrites with `allowOverwrite: true`). `delete_skill` is not evaluated because its baseline failed (the skill to
delete is not found), and the other seven tools are not evaluated (no effect). Engine findings 1, 3 and 4 of "S5 after
the engine hardening" are resolved and finding 2 is resolved in part. The decision is now PRIMARY (see "S5 after the
pre-M3 batch").

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

## S5 after the engine hardening

This section's decision and its reasons replace the decision and the reasons of the earlier S5 section above.

The same two templates at the same commits, run again on 2026-11-27 with the engine at commit `8e7ebbc` (Windows 10,
Node 24.15.0, scripted mock model and fake provider: no tokens were spent and no request left the machine). Each
template was cloned again into its own scratch directory outside this repository. Nothing was posted to either
repository, no real credentials were used, and the template source is unchanged: `git status` shows only
`crashtest.config.json` and `.crashtest/` in the SRE clone and nothing in the triage clone.

**Regression.** `pnpm test:e2e` from `packages/engine` at `8e7ebbc` exited 0 after 54.8 min: 31 tests, 30 pass and
1 is skipped (the Windows-only skip of "SIGINT leaves no listener behind"). The ten earlier zoo ratings are unchanged
(`naive` 1, `fs_effect` 1, `approval_naive` 2, `callid_guard` 3, `phantom_failure` 4, `opkey_guard`, `upstream_key`,
`benign_labels` and `check_before_act` 5, `readonly` not evaluated: no effect), and acme still goes from 1 to 5 stars.
The two new zoo tools rate as intended: `post_reads`, whose only requests are reads sent as POST, is not evaluated (no
effect), and `session_auth`, which checks the session identity, is not evaluated (baseline failed) without an
identity and gets 1 star with one.

| Template | Commit | eve installed | Install | Config | `crashtest plan` |
|---|---|---|---|---|---|
| `vercel-labs/eve-sre-agent-template` | `b2ef701` | 1.2.0 | `pnpm install --frozen-lockfile`, exit 0 | 24 lines | exit 0: 11 tools, 66 cells |
| `vercel-labs/eve-pr-triage-agent-template` | `5f3d0ac` | 0.7.4 | `npm ci`, exit 0 | none | exit 1 after 0.5 s, before a lab exists: `crashtest: eve 0.7.4 is installed for <dir>, but crashtest needs eve 1.2.0 or later (older versions lack mockModel in eve/evals and eve dev --resume): upgrade eve in the app` |

### SRE configuration

24 lines with four keys:

- `auth`: `{"authenticator": "slack-webhook", "principalType": "user", "principalId": "U0CRASHTEST", "issuer":
  "slack:T0CRASHTEST", "attributes": {"team_id": "T0CRASHTEST"}}`. That is the engine README's example identity plus
  `issuer`: the template's `resolveSlackUser` also requires `issuer` to be `slack:<team_id>`. With the README example
  as it is, `watch_slack_channel` still answers `Authorization denied: not in a Slack context` (2 baselines, 33 s).
- `env`: a fake unsigned `VERCEL_OIDC_TOKEN` (header `{"alg":"none","typ":"JWT"}`, payload `{"exp":4102444800}`,
  empty signature), which Vercel Connect needs before it asks for the Slack bot token, and a fake
  `BLOB_READ_WRITE_TOKEN` in the shape `@vercel/blob` parses (`vercel_blob_rw_<store>_<secret>`, store `crashtest`).
- `fixtures`: `GET https://vercel.com/api/blob?*` answers an empty listing (`{"blobs": [], "hasMore": false}`). With a
  Blob token, every turn first lists the custom skills (two GETs, global and user prefix); the generic answer `{}`
  made the template log `custom skills unavailable` on every turn and made `list_skills` return an error object.
- `scenarios`: an input for each of six tools whose generated input the template rejects: Slack ids (`C0CRASHTEST`,
  `U0CRASHTEST`), a Slack timestamp (`1712606400.000100`) and an evidence id (`evidence-1`).

### Per tool

`crashtest run` on the SRE clone: exit 0, 40 runs, 781 s (13.0 min), `Agent rating: ★★☆☆☆ (2/5) · 3 of 11 tools
evaluated · In lab: 40 cells · eve 1.2.0 · commit b2ef701+dirty` (the untracked configuration makes the clone dirty).
Cells took 12 to 14 s (baseline), 25 s (post-effect-fast), 27 s (post-effect-slow) and 34 to 40 s (post-settle,
which adds 2.5 s of latency to every request; `watch_slack_channel` makes three).

| Tool | Before (earlier S5) | Now | Runs | Wall s |
|---|---|---|---|---|
| `create_skill` | not run | 2 stars: dup (stable), dup (fresh), clean (abandoned), clean (abandoned) | 8 | 192.5 |
| `unwatch_slack_channel` | not run | 2 stars: same four verdicts | 8 | 190.2 |
| `watch_slack_channel` | not evaluated: no external effect, stopped at the Slack-context check (2 runs, 27.3 s) | 2 stars: same four verdicts | 8 | 194.0 |
| `delete_skill` | not run | not evaluated: no external effect; the skill to delete is not found (see engine finding 2) | 2 | 27.1 |
| `evidence_list` | not run | not evaluated: no external effect (reads eve session state) | 2 | 25.1 |
| `evidence_record` | not evaluated: no external effect (2 runs, 24.7 s) | not evaluated: no external effect (writes eve session state) | 2 | 24.8 |
| `evidence_remove` | not run | not evaluated: no external effect (eve session state; `not_found` in a fresh turn) | 2 | 24.8 |
| `list_skills` | not run | not evaluated: no external effect (Blob listings only) | 2 | 24.8 |
| `read_slack_user` | not run | not evaluated: no external effect (`users.info` sent as POST is a read) | 2 | 24.8 |
| `slack_read_channel_messages` | 1 star, wrong for a read (10 runs, 249.7 s); not evaluated only with `effects.ignore` | not evaluated: no external effect, without `effects.ignore` | 2 | 24.9 |
| `slack_read_thread` | not run | not evaluated: no external effect (`conversations.replies` sent as POST is a read) | 2 | 24.6 |
| `apply_labels` (triage) | not evaluated: baseline failed, on eve 1.5.0 after three source changes | not run: `plan` refuses the locked eve 0.7.4 | — | — |

- **What the three rated tools repeat.** Each writes one Vercel Blob object at a fixed path. `create_skill` PUTs
  `sre-custom-skills/global/crashtest-name.json`; `watch_slack_channel` PUTs
  `sre-channel-watch/T0CRASHTEST/C0CRASHTEST.json`, after the session check and a `conversations.info` read that the
  fake provider answers with `is_member: true`; `unwatch_slack_channel` POSTs
  `{"urls": ["sre-channel-watch/T0CRASHTEST/C0CRASHTEST.json"]}` to `vercel.com/api/blob/delete`. When eve replays
  the step, the tool writes the same object again: the PUT body differs only in `updatedAt` or `watchedAt`, which the
  two baselines already show as varying, and the delete body is the same. Vercel Blob is outside the fake provider's
  catalog, where every POST counts and a PUT counts unless its body is the same, so each repeat is a second state
  change, 2 of 2 in both fast cells, and a same-id repeat of a tool that requires approval is 2 stars. The rating is
  what the lab measured: the tool ran twice and wrote twice. In the real store the second write overwrites the same
  object with a later timestamp, or deletes an object that is already gone; no second record appears (engine
  finding 1).
- **post-effect-slow and post-settle are clean (abandoned)** for all three, as for `approval_naive`: eve recovered the
  approved call as interrupted, and the scripted model did not issue it again. The fresh cell replayed the approved
  call with its id and its text (one call in the stream, `ct-call-1-<pid of the killed process>`, and the same
  `description` in both PUTs of `create_skill`), as `approval_naive`'s fresh cell does in the zoo, so its
  `dup (fresh)` is a same-id replay too. The stars come from the stable cell either way.
- **The crash point skips the reads.** In every crash cell of `watch_slack_channel` the ledger holds the Vercel Connect
  token POST and the `conversations.info` POST with `mutating: false`, and the crash came right after the Blob PUT,
  the first request that is an effect. In the earlier S5 the crash fired on the token exchange.
- **Requests the template makes on its own.** As before, the extension, the connections and the channels made no
  request at startup. With a Blob token, the template's custom-skill resolver lists two Blob prefixes at the start of
  every turn (GETs, so no effect); `delete_skill` adds a GET of the skill object.

### Blockers of the earlier section

1. **Session auth: resolved.** The top-level `auth` key gives every lab session the configured identity, and
   `create_skill`, `watch_slack_channel` and `unwatch_slack_channel` pass the template's Slack check and reach their
   write. What remains: the identity must match what the tool checks. The README example lacks `issuer`, which this
   template compares with `slack:<team_id>`, and with the example as it is the tool refuses and crashtest reports "no
   external effect" with no hint (engine finding 3); since this run, the README example has the shape of the identity
   eve's Slack channel builds, `issuer` included. A GitHub identity could not be tried, because the triage
   template does not run.
2. **Reads sent as POST: resolved for Slack and Vercel Connect.** `slack_read_channel_messages`, `slack_read_thread`
   and `read_slack_user` are not evaluated (no effect) without any `effects.ignore`, so the earlier workaround is no
   longer needed for them. Their ledgers keep the Connect token POST and the Slack read POST, both with
   `mutating: false`, and the progress lines report 0 effects for their baselines. These three tools ran only
   baselines; the crash cells of `watch_slack_channel` show the crash point skipping the reads: its ledgers keep the
   Connect token POST and the `conversations.info` POST with `mutating: false`, and the crash lands after the Blob PUT
   (see above). What remains: on a host outside the catalog every POST is still an effect, also one that changes
   nothing, such as a second Vercel Blob delete of the same object (engine finding 1).
3. **`disableTool()` files: resolved in discovery, not shown on a template.** Discovery skips an unlisted file that
   calls `disableTool(` (unit test "a file that only disables a framework tool is neither a tool nor skipped"). The
   SRE template has no such file, and on the triage template `plan` stops at the eve version check, before
   discovery.
4. **No minimum eve version: resolved.** `plan` on the triage template exits 1 with the version message above
   instead of the overlay's module-resolution error, after 0.5 s and before any lab is created.
5. **Generic baseline hint: resolved for the tool's own error, with one gap.** The auth and input hints now come only
   from the error of the tool call itself, as the zoo's `session_auth` shows (baseline failed without an identity, with
   the auth hint). On the SRE template no baseline failed once the inputs were set. With its generated input
   (`evidenceId_ct_1`), `evidence_remove` failed both baselines, but the AI SDK rejected the input before the tool
   ran (`AI_InvalidToolInputError: Invalid input for tool evidence_remove`), eve recorded no call, and crashtest gave
   the reason "the model never called evidence_remove" with the general hint, which does name
   `scenarios.evidence_remove.input` (engine finding 4).

Blocker 6 (the triage template is behind eve) is unchanged: its lockfile still pins eve 0.7.4.

### Engine findings (reported, not fixed)

1. **A repeated write of one object counts as a second state change on a host outside the catalog.** The fake
   provider treats `vercel.com/api/blob` generically: a PUT is a state change unless its body is the same as an
   earlier one, and every POST is. A PUT whose body differs only in a field that the two baselines show as varying
   (`updatedAt`, `watchedAt`) therefore counts again, and so does a second POST to `/api/blob/delete` with the same
   body. Besides, the generic PUT slot is the host and path without the query, and Blob names the object in the
   query (`?pathname=`), so the lab does not tell writes to different objects apart either: the same body PUT to
   another object would read as a benign repeat. Possible fixes: model Vercel Blob in the catalog (a PUT by
   `pathname` as an overwrite, a delete as idempotent, a GET by object), or treat a PUT repeat whose body differs
   only in the baselines' varying fields as benign. Until then, the three 2-star ratings above say that a crash makes
   the tool write twice, not that it creates a second record.
2. **The fake provider keeps no Blob objects**, so `delete_skill` finds no skill to delete
   (`No global skill named "crashtest-name" was found.`) and makes no effect. A fixture cannot stand in: it is
   stateless and would still return the skill after the delete, so the lab would show a second delete that a real
   replay does not make. On a real replay the GET finds the object gone and the tool answers that the skill was not
   found, after it deleted it; the lab cannot show that either (finding 3).
3. **A refusal returned as a value reads as "no external effect".** The SRE tools return
   `{"success": false, "error": ...}` instead of throwing, so a session check that refuses the lab identity completes
   the call, the baseline has no effect, and the reason gets no hint. A reason that mentions a baseline output with
   `success: false` or an `error` field would point at `auth` or the input.
4. **A call that the AI SDK rejects for its input is not a call in eve's stream.** eve 1.2.0 sends the
   `AI_InvalidToolInputError` back to the model (it is in the session's trace), but the stream has no `call.requested`
   or `call.settled` for it, so crashtest says that the model never called the tool and gives the general hint
   instead of the input hint.

### Other checks

- **Lab channel shim on eve 1.2.0: works.** The shim (`localDev` from `eve/channels/auth`, `eveChannel` from
  `eve/channels/eve`) compiled in discovery and in all 40 runs plus the probes, every baseline turn completed, and the
  configured identity reached `ctx.session.auth.current`: the three write tools passed `resolveSlackUser`, which
  checks the authenticator, the principal type, the principal id, `attributes.team_id` and `issuer`.
- **Channel files.** The SRE template has `agent/channels/eve.ts`, `slack.ts` and `webhook.ts`; the triage template
  has `agent/channels/eve.ts` and `github.ts`. Neither has an `eve.mjs` or `eve.js`, so the case where the overlay
  writes its `eve.ts` next to an app's own JavaScript eve channel does not occur in either template. In the SRE lab
  the original channel (which already accepts only `localDev()` callers) was kept as `eve.ctorig.spec.ts`.

### Extra probe: `crashtest fix` on `watch_slack_channel`

`crashtest fix --tool watch_slack_channel --report .crashtest/report.json` without `--apply`, so the clone stayed as
it was: exit 0 after 355 s. The report was ignored ("made on uncommitted changes": the untracked configuration), so a
fresh lane rated the tool 2 stars again, with the same four verdicts. upstream-key did not apply (no fetch call to an
idempotency-capable host). ledger-guard changed `agent/tools/watch_slack_channel.ts` and added
`agent/lib/crashtest-idempotency.ts`, imported as `../lib/crashtest-idempotency.ts` because the template's
`tsconfig.json` sets `NodeNext` with `allowImportingTsExtensions`, and the patch passed the type check against that
`tsconfig.json` (strict). Its lane: 5 stars in 6 runs (143.9 s), every crash cell clean (abandoned). As with
`post_slack_update` in M2, eve recovered each call as interrupted and the scripted model did not issue the approved
call again, so no attempt read the guard's record. stdout: `In lab: watch_slack_channel ★★☆☆☆ → ★★★★★ with
ledger-guard (6 runs, eve 1.2.0)`, followed by the trade-off and store lines.

**Decision: FALLBACK** — the three 2-star ratings are repeats that the real store absorbs: `create_skill` and `watch_slack_channel` PUT the same object again with `allowOverwrite: true`, in a body that differs only in fields the two baselines mark as varying (the fake provider hashes the raw body instead of masking those fields first), and `unwatch_slack_channel` repeats a delete of an object that is already gone (engine finding 1). The reference agent `examples/acme-support` leads the demo until finding 1 is fixed and S5 is run again on the SRE template, which is when the decision can become PRIMARY.

## S5 after the pre-M3 batch

This section's decision and its reasons replace those of "S5 after the engine hardening" above.

The SRE template at the same commit, run again on 2026-11-27 with the engine at commit `cd994e2` (Windows 10, Node
24.15.0, scripted mock model and fake provider: no tokens were spent and no request left the machine). The scratch
clone of the earlier section, outside this repository, was used again: it is at `b2ef701` with the dependencies of
its `pnpm install --frozen-lockfile` (eve 1.2.0, `@vercel/blob` 2.4.0), and the earlier configuration and output were
moved out of it first. Nothing was posted to the template repository, no real credentials were used, and the template
source is unchanged: `git status` shows only `crashtest.config.json` and `.crashtest/`. The triage template was not
run again; its lockfile still pins eve 0.7.4.

**Regression.** `pnpm test:e2e` from `packages/engine` at `cd994e2` exited 0 after 3695 s (61.6 min): 37 tests, 36
pass, none fails and 1 is skipped ("SIGINT leaves no listener behind", which runs only on POSIX). The twelve earlier
zoo ratings are unchanged (`naive` 1, `fs_effect` 1, `approval_naive` 2, `callid_guard` 3, `phantom_failure` 4,
`opkey_guard`, `upstream_key`, `benign_labels` and `check_before_act` 5, `readonly` and `post_reads` not evaluated: no
effect, `session_auth` not evaluated: baseline failed without an identity, and 1 star with one). The five new zoo
tools rate as intended: `put_timestamped` (a PUT that stamps the time on one object) and `blob_overwrite` (a Vercel
Blob put with `allowOverwrite`) get 5 stars with benign repeats; `blob_default` (a put with the default options, which
the store refuses once the first upload happened) gets 4 stars; `refuses_as_value` is not evaluated (baseline failed)
with the auth hint; `strict_input` is not evaluated (baseline failed) with the input hint and gets 1 star with its
input. acme still goes from 1 to 5 stars, and ledger-guard still takes `naive` from 1 to 5 stars in the fix test.

| Template | Commit | eve installed | `@vercel/blob` | Config | `crashtest plan` | `crashtest run` |
|---|---|---|---|---|---|---|
| `vercel-labs/eve-sre-agent-template` | `b2ef701` | 1.2.0 | 2.4.0 | 21 lines | exit 0 after 20 s: 11 tools, 66 cells | exit 0 after 625 s (10.4 min), 34 runs |

### SRE configuration

21 lines with three keys, made from the earlier 24-line configuration:

- `auth`: the engine README's example identity as it is, `{"authenticator": "slack-webhook", "issuer":
  "slack:T0CRASHTEST", "principalType": "user", "principalId": "slack:T0CRASHTEST:U0CRASHTEST", "attributes":
  {"author_type": "user", "channel_id": "C0CRASHTEST", "team_id": "T0CRASHTEST", "user_id": "U0CRASHTEST"}}`. It
  passes the template's `resolveSlackUser` (`agent/lib/auth.ts:15-33`: authenticator, principal type, a non-empty
  principal id, `attributes.team_id`, and `issuer` equal to `slack:<team_id>`). With this principal id the user-scoped
  skill prefix is `sre-custom-skills/users/slack-t0crashtest-u0crashtest/`, and a watch record's `watchedBy` is
  `slack:T0CRASHTEST:U0CRASHTEST`.
- `env`: the same two fakes as before, an unsigned `VERCEL_OIDC_TOKEN` with a far-future expiry and a
  `BLOB_READ_WRITE_TOKEN` in the `vercel_blob_rw_<store>_<secret>` shape (store `crashtest`).
- `scenarios`: the same six inputs.
- No `fixtures`: the Blob listing fixture is gone. The fake provider's Blob catalog answers the two listings that the
  template's custom-skill resolver makes at the start of every turn (`GET vercel.com/api/blob?prefix=…&mode=expanded`,
  global and user prefix) with the stored objects, none in a fresh run, and `list_skills` returns
  `{"count": 0, "skills": [], "success": true}`.

### Per tool

`crashtest run` on the clone: exit 0, 34 runs, 625 s (10.4 min), `Agent rating: ★★★★★ (5/5) · 3 of 11 tools evaluated
· In lab: 34 cells · eve 1.2.0 · commit b2ef701+dirty` (the untracked configuration makes the clone dirty). Every
crash cell was clean, so no confirmation run was needed (the earlier run had 40 runs). Cells took 12 to 15 s
(baseline), 25 s (post-effect-fast), 27 to 28 s (post-effect-slow) and 34 to 39 s (post-settle).

| Tool | Before (S5 after the engine hardening) | Now | Runs | Wall s | Blob write and its options | Blob behavior the rating relies on |
|---|---|---|---|---|---|---|
| `create_skill` | 2 stars: dup (stable), dup (fresh), clean (abandoned), clean (abandoned); 8 runs, 192.5 s | 5 stars, benign repeats: clean (1 benign) in both fast cells, clean (abandoned) in slow and post-settle | 6 | 141.5 | `put(pathname, content, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" })` at `agent/lib/blob.ts:40-45`, called from `agent/lib/skills/store.ts:196-199`; the body's `updatedAt` is set at `store.ts:193` | A put with `allowOverwrite: true` and no random suffix replaces the object at its pathname: the repeat is not refused and leaves one object, with the later `updatedAt` |
| `watch_slack_channel` | 2 stars: same four verdicts; 8 runs, 194.0 s | 5 stars, benign repeats: the same four verdicts as `create_skill` | 6 | 142.7 | the same `put` at `agent/lib/blob.ts:40-45`, called from `agent/lib/channel-watch/store.ts:77`; the body's `watchedAt` is set at `store.ts:74` | the same overwrite, with the later `watchedAt` |
| `unwatch_slack_channel` | 2 stars: same four verdicts; 8 runs, 190.2 s | 5 stars, benign repeats: the same four verdicts as `create_skill` | 6 | 137.9 | `del(pathname)` with no options (no `ifMatch`) at `agent/lib/blob.ts:15`, called from `agent/lib/channel-watch/store.ts:89` | a delete of an object that is gone succeeds and changes nothing (Vercel's `del()` reference: it "won't throw if the blob url doesn't exist"); the one state change is the first delete of an object the lab never saw, which the lab takes as existing |
| `delete_skill` | not evaluated: no external effect; the skill to delete is not found; 2 runs, 27.1 s | not evaluated: baseline failed; the reason quotes the refusal `No global skill named "crashtest-name" was found.` and gives the general hint (`scenarios.delete_skill.input`, `auth`, `env` and `fixtures`) | 2 | 27.1 | — | — |
| `evidence_list` | not evaluated: no external effect; 2 runs, 25.1 s | not evaluated: no external effect (reads eve session state) | 2 | 24.5 | — | — |
| `evidence_record` | not evaluated: no external effect; 2 runs, 24.8 s | not evaluated: no external effect (writes eve session state) | 2 | 24.4 | — | — |
| `evidence_remove` | not evaluated: no external effect; 2 runs, 24.8 s | not evaluated: no external effect (eve session state; `not_found` in a fresh turn) | 2 | 24.7 | — | — |
| `list_skills` | not evaluated: no external effect (Blob listings only); 2 runs, 24.8 s | not evaluated: no external effect (Blob listings only, now answered by the catalog) | 2 | 24.6 | — | — |
| `read_slack_user` | not evaluated: no external effect; 2 runs, 24.8 s | not evaluated: no external effect (`users.info` sent as POST is a read) | 2 | 24.5 | — | — |
| `slack_read_channel_messages` | not evaluated: no external effect; 2 runs, 24.9 s | not evaluated: no external effect (`conversations.history` sent as POST is a read) | 2 | 24.6 | — | — |
| `slack_read_thread` | not evaluated: no external effect; 2 runs, 24.6 s | not evaluated: no external effect (`conversations.replies` sent as POST is a read) | 2 | 24.4 | — | — |

- **What the three rated tools repeat.** The same objects as before: `create_skill` PUTs
  `sre-custom-skills/global/crashtest-name.json`, `watch_slack_channel` PUTs
  `sre-channel-watch/T0CRASHTEST/C0CRASHTEST.json` (after the Vercel Connect token POST and the `conversations.info`
  POST, both `mutating: false`), and `unwatch_slack_channel` POSTs
  `{"urls": ["sre-channel-watch/T0CRASHTEST/C0CRASHTEST.json"]}` to `vercel.com/api/blob/delete`. In both fast cells
  eve replayed the approved call (`mock-tool-call-2-0-1-1` in the stable cell; one call
  `ct-call-1-<pid of the killed process>` in the fresh cell, with the same input text in both writes), and after the
  restart the tool wrote the same object again.
- **Why the repeats are benign.** For a put, `@vercel/blob` 2.4.0 sends the two options as `x-add-random-suffix: 0`
  and `x-allow-overwrite: 1`, and the fake provider answered the second put with 200 (without the overwrite option
  it refuses a put to a stored object with "This blob already exists, use allowOverwrite: true to overwrite it"). The
  ledger keeps that put as a state change, since its body differs in `updatedAt` (`watchedAt` for
  `watch_slack_channel`). The two baselines show that field as varying on `PUT vercel.com/api/blob/`, and the put names
  its object (`vercel-blob:<pathname>`), so the cell counts it as a benign repeat, and the summary says what that
  rests on: "A repeated write went to the same object and differed only in `updatedAt`, which vary between the
  baselines; the lab assumes the service overwrites the object." For `unwatch_slack_channel` the second delete is
  benign in the fake provider itself (`objects already deleted`), which also shows that the provider state outlived
  the crash.
- **post-effect-slow and post-settle are clean (abandoned)** for all three, as before: eve recovered the approved call
  as interrupted, and the scripted model did not issue it again. So no cell of this run sent the call again with
  reworded text. If a real model issued `create_skill` again with a reworded `description` (a free-text field that
  does not vary between the baselines), the lab would count the second put as a state change, although the store
  would overwrite the same object; this run does not exercise that case.
- **`delete_skill`** reads the skill before it deletes it (`agent/lib/skills/store.ts:231-237`), with
  `get(pathname, { access: "private", useCache })` (`agent/lib/blob.ts:29-38`). In `@vercel/blob` 2.4.0 that is a GET of
  `crashtest.private.blob.vercel-storage.com/sre-custom-skills/global/crashtest-name.json`, which gets the generic
  answer. The template logs `skipping malformed skill`, finds no skill, sends no delete and returns
  `{"error": "No global skill named \"crashtest-name\" was found.", "success": false}`. The refusal names no
  authorization or input problem, so the reason gets the general hint.
- **The crash point skips the reads**, as before: in every crash cell of `watch_slack_channel` the crash came right
  after the Blob PUT, the first request that is an effect.

### Engine findings of the earlier section

1. **A repeated write of one object on a host outside the catalog: resolved for Vercel Blob.** Blob is in the
   catalog, a put names its object by `pathname`, a repeated overwrite that differs only in the baselines' varying
   fields is a benign repeat, and a second delete of a deleted object is a benign repeat; the three 2-star ratings are
   now 5 stars. The catalog tells writes to different objects apart by `pathname`, so the same body put to another
   object is no longer read as a repeat. What remains: on hosts outside the catalog, an object is still its path
   without the query, and only top-level keys of object bodies are masked.
2. **The fake provider keeps no Blob objects: resolved in part.** It now keeps the objects of a run across the crash
   and answers head and list from them. It does not serve their content, and no object can be stored before a turn,
   so `delete_skill` still finds no skill to delete. Its reason is now a failed baseline that quotes the refusal,
   instead of "no external effect".
3. **A refusal returned as a value: resolved.** Besides `delete_skill` above, a probe of `watch_slack_channel` with
   the identity of the earlier README example (no `issuer`; `crashtest lane`, 2 runs, 27.3 s) is not evaluated
   (baseline failed) with the auth hint: "the call returned a refusal: Authorization denied: not in a Slack context —
   set auth or scenarios.watch_slack_channel.auth in crashtest.config.json to give the lab session the identity this
   tool checks". With that identity the earlier section got "no external effect" and no hint.
4. **A call the AI SDK rejects for its input: resolved, also on eve 1.2.0.** A probe of `evidence_remove` with its
   generated input (`{"evidenceId": "evidenceId_ct_1"}`; `crashtest lane`, 2 runs, 25.1 s) is not evaluated (baseline
   failed) with the input hint: "the call was rejected before evidence_remove ran: AI_InvalidToolInputError: Invalid
   input for tool evidence_remove: … must match pattern /^evidence-\d+$/u — set scenarios.evidence_remove.input in
   crashtest.config.json". What remains: generated inputs do not honor `pattern`, so the configuration still needs
   the input.

Both probes ran after the run, each with its own configuration file outside the clone (`--config`); the report
covers the run only.

### Engine bugs (reported, not fixed)

None found: every verdict and every reason follows the README's rules. One reporting gap: the 5-star summary of
`unwatch_slack_channel` ("One state change in every cell; repeated requests did not change provider state.") does
not say that its one state change is the delete of an object the lab never saw and takes as existing (the README
Limits say it), while the summaries of the other two tools name the assumption their benign repeats rest on. If the
channel was not watched in the real store, the first delete changes nothing and the repeat changes nothing either,
so the rating would not change.

### Decision

1. **The full regression passed: holds.** `pnpm test:e2e` exited 0 with the zoo and acme ratings above.
2. **An SRE tool with an external effect gets a star rating, with at most 30 configuration lines: holds.** Three do,
   with 21 lines.
3. **No rating below 5 stars counts a repeat that the real store absorbs: holds.** No SRE rating is below 5 stars;
   `delete_skill` and the seven tools without an effect are not evaluated, which is neither a rating nor a pass.
4. **No benign verdict rests on a repeat that the real store would refuse or duplicate: holds.** The benign repeats
   are a put with `allowOverwrite: true` and `addRandomSuffix: false` (`agent/lib/blob.ts:40-45`), which the store
   applies as an overwrite of the same object, and a `del()` without `ifMatch` (`agent/lib/blob.ts:15`), which the
   store accepts for an object that is gone.

**Decision: PRIMARY** — all four conditions hold: the SRE template's three Blob write tools get 5 stars with a 21-line configuration, and every benign repeat behind those ratings is an overwrite or a delete that the real store absorbs, given the write options in the template source. The template appears in the demo as the real case, rated as it is here, and `examples/acme-support` still carries the story from 1 to 5 stars.

## M2 fix verification

The reference agent `examples/acme-support` (six tools, eve 1.5.0) through the demo flow: `crashtest run`, then
`crashtest fix --all --apply --report .crashtest/report.json`, then `crashtest run` again. Source: the e2e test
`acme: 1 star to 5 stars` (`test/e2e/acme.test.ts`), which drives the CLI on a fresh copy of the example at
`examples/acme-support/.crashtest/e2e-copy`. Git ignores that directory, so the first report records commit
`7ac9f32` with a clean tree, `fix` takes its before ratings from that report instead of running new lanes, and the
example itself stays unprotected. `7ac9f32` does not contain the example, but the engine and its templates at
`7ac9f32` are unchanged through `dd200c3`, the commit that adds the example. Windows 10, Node 24.15.0, scripted mock
model and fake provider: no tokens were spent and no request left the machine. The test ran twice with the same
verdicts in every cell.

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
