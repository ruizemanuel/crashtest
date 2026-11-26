# M0 spike findings

Summary (2026-11-26, eve 1.5.0; all raw outputs below were re-recorded with English prompts):
- **S1 confirmed** — with a real model (`anthropic/claude-haiku-5.5`), a crash right after the effect produced 2 effects in 3/3 runs and the provider tool-call id changed on every replay (3/3), so a guard keyed on `ctx.callId` fails. The free text came back identical in these 3 English runs, but an earlier run of the same experiment with a Spanish prompt rewrote the text in 3/3 replays, so a guard keyed on the full input is unreliable too.
- **Model-driven duplicate observed with a real model** — when eve reported the call as "may or may not have taken effect", the model tried to check (it spawned a read-only subagent to search logs), found nothing and sent again in 1 of 3 runs (0 of 3 in the earlier Spanish-prompt runs). The model has no reliable way to check without a provider lookup tool.
- **S2 PRIMARY** — in-place `.ctorig.spec.ts` overlay + agent shim works with relative and `#lib` imports; tool listed once, no diagnostics.
- **S3 PRIMARY** — a preload (`HttpRequestInterceptor`) intercepts a tool's fetch and crashes at will from outside the tool. post-effect-fast: 2 effects with the same id. post-settle is a timing window: eve re-runs the tool (same id) while the stream is not yet flushed, and recovers the call as `abandoned` once it is.
- **S4 PRIMARY** — the same loop runs in Vercel Sandbox (node:24, 2 vCPU) with the same results; Active CPU 23–30 s per run including install (n=3 stored; 18–40 s across all runs made).
- **Driver fix** — POSIX kill-by-port killed the caller itself (`lsof -ti tcp:<port>` also lists clients); now `lsof -nP -iTCP:<port> -sTCP:LISTEN -t`, never the own pid (`spikes/lib/ports.mjs`; check fails before the fix and passes after it on WSL Linux and Windows).
- AI Gateway spend for all real-model runs: US$0.014 (dedicated key with a US$30 budget).

## S1 callId/input stability

**Decision: hypothesis confirmed for callId; free text is not reliably stable either.** Real model `anthropic/claude-haiku-5.5`; crash at post-effect-fast using the S3 preload; prompt "Tell Alice about her order"; 1 baseline + 3 crash runs. Raw outputs: `spikes/s1-real-model/results/`.

| Run | Effects | Same callId? | Same text? | eve stream |
|---|---|---|---|---|
| baseline (no crash) | 1 | — | — | 1 call completed (`toolu_…` provider id) |
| 1 | **2** | no | yes | 1 call completed |
| 2 | **2** | no | yes | 1 call completed |
| 3 | **2** | no | yes | 1 call completed |

Text in every run: "Hi Alice! Good news: your order 4213 shipped today. Thanks for your patience!". An earlier run of the same experiment with a Spanish prompt produced different wording in each of its 3 replays (raw files not kept so the repository stays in English).

Implications for the engine design:
1. On replay eve re-runs the model call and the provider issues a new tool-call id (3/3 here, 3/3 in the earlier runs): a guard keyed on `ctx.callId` never catches it.
2. The regenerated input may or may not match the first attempt, so a guard keyed on a hash of the full input is unreliable.
3. The duplicate is invisible in eve's stream: only the replayed call appears.
4. Fix strategy order: (a) upstream idempotency keyed on **business identity fields** (recipient + order id + message kind), never free text; (b) check-before-act against the provider; (c) a ledger guard keyed on (session, turn, tool, identity fields), with the trade-off stated in the report (it also blocks a legitimate second call with the same identity in the same turn).
5. The mock's ids are stable across restarts (its counter resets), which made a callId fix look correct in the reference spike: mock-only cells must never be the sole evidence for a "fixed" claim, and the fresh-id cell must also perturb free-text fields.

### Real model after an interrupted call (post-effect-slow)

Crash 2 s after the effect, so the call's start is durable and recovery marks it `abandoned`; eve tells the model through a framework user message ("may or may not have taken effect… check whether it already took effect"). Raw outputs: `spikes/s1-real-model/results/slow-run-*.json`.

| Run | Effects | What the model did |
|---|---|---|
| 1 | **2** | Spawned a read-only subagent (`agent` tool) to search logs and traces; it answered "NOT_FOUND"; the model sent the message again |
| 2 | 1 | Did not retry |
| 3 | 1 | Spawned the same kind of subagent; did not retry |

The model follows eve's advice to check before retrying, but with no tool that queries the provider its check is guesswork, and in 1 of 3 runs it produced a duplicate. This makes "check-before-act against the provider" a concrete, demonstrable recommendation.

## S2 overlay

**Decision: PRIMARY** — in-place overlay works on eve 1.5.0 with a "user" agent whose tool uses a relative import (`../lib/format`) and a package-imports alias (`#lib/endpoint.ts` via `"imports": {"#lib/*": "./agent/lib/*"}`), and whose agent declares a string model. Script: `spikes/s2-overlay/apply-overlay.mjs`; raw outputs: `spikes/s2-overlay/results/`.

- `apply-overlay.mjs` renames `agent/agent.ts` and each `agent/tools/<t>.ts` to `*.ctorig.spec.ts` and writes shims: `defineAgent({ ...original, model: mockModel(...) })` and `defineTool({ ...original })`. Running it twice leaves the same tree (idempotent).
- `eve info --json` after the overlay: `notify` listed exactly once (the `.spec.` originals are not discovered), model `crashtest/crashtest-script`, diagnostics `{errors:0, warnings:0}`.
- Runtime: baseline 1 effect with text `"Hi Alice (for alice)"` (both imports resolved); post-effect-fast 2 effects, same callId.
- `eve info --json` `tools` also lists framework defaults (`bash, read_file, write_file, edit_file, web_fetch, web_search, agent`); the engine must separate authored tools (files under `agent/tools/`) from defaults.

## S3 preload interception

**Decision: PRIMARY** — a preload loaded with `NODE_OPTIONS=--import=file:///…/preload.mjs` reaches the process that runs tools inside `eve dev` (eve 1.5.0, local world, Windows). `HttpRequestInterceptor` from `@mswjs/interceptors/http` 0.45 (socket level: fetch/http/https/undici) intercepts a tool's `fetch` to an unresolvable `https://api.provider.test`, records it on arrival and answers as a fake provider; it also kills the process at the chosen point. Every run summary records its crash point, provider latency and marker. Raw outputs: `spikes/s3-preload/results/*.json`.

| Crash point | Runs | serverDied | Effects (ledger) | callIds of the effects | What eve's stream shows |
|---|---|---|---|---|---|
| none | 1 | no | 1 | mock-1 | 1 call, completed |
| post-effect-fast (kill on request arrival, before response) | 1 (+6 in the reference spike) | yes | **2** | mock-1, mock-1 (same) | 1 call, completed — duplicate invisible |
| post-effect-slow (arrival, wait 2 s, kill), scripted mock | 3 | yes | 2 (3/3) | mock-1, mock-2 | call 1 `abandoned`, call 2 completed |
| post-settle, zero-latency provider | 3 Windows + 1 Linux | yes | **2** (4/4) | mock-1, mock-1 (same) | 1 call, completed |
| post-settle, provider latency 2.5 s | 3 Windows + 1 Linux | yes | 2 (mock re-call) | mock-1, mock-2 | call 1 `abandoned` |

Findings:
1. **Interception from outside the tool works** without editing user code; the tool needs no wrapper for HTTP effects.
2. **post-effect-slow → `abandoned`, the model decides.** After 2 s the call's start was durable, so recovery marked it `abandoned` instead of re-running it, and told the model through a framework user message (`eve/dist/src/harness/interrupted-attempt.js`), not a tool result. The scripted mock re-calls whenever it sees no tool result, so its second call (new id) is by construction; real-model behavior is measured in S1 (1 duplicate in 3 runs). A pessimistic-retry cell must trigger on that framework message.
3. **post-settle is a timing window, not a guarantee either way.** Hooks run after `writer.write()` resolves, which happens before the async flush (`eve/dist/src/execution/publish-session-events.js`). With a zero-latency fake provider the settle lands inside the same flush window as the effect, so a crash re-runs the step and the tool fires again with the same id (4/4, Windows and Linux, local world). With 2.5 s of provider latency the start is durable and the call is recovered as `abandoned` (4/4). eve documents this limit (`docs/concepts/execution-model-and-durability.mdx`, "Resuming after a crash"); what is noteworthy is that a call already reported **settled** to hooks can still re-run or lose its result. Only the local world was tested (not Vercel Workflow). Worth a constructive note to the eve team, not a bug claim.
4. Hook names must start with a letter (`__crashtest` is rejected by discovery); use e.g. `agent/hooks/crashtest_probe.ts`.
5. Each crash run took 16–19 s wall clock on the dev PC (two `eve dev` startups).

## S4 Vercel Sandbox

**Decision: PRIMARY** — the crash loop runs inside Vercel Sandbox (image `vercel/sandbox/node:24`, 2 vCPU, `persistent: false`, Hobby), authenticated with the `crashtest` project's OIDC token (`vercel link` + `vercel env pull`). Script: `spikes/s4-vercel-sandbox/run.mjs`; raw outputs: `spikes/s4-vercel-sandbox/results/`.

| Run | Install | Crash run | Active CPU (SDK `activeCpuUsageMs`, whole session) | Result |
|---|---|---|---|---|
| post-effect-fast | 3.5 s | 11.6 s | 25.8 s | 2 effects, same id |
| post-settle, latency 0 | — | — | 30.4 s | 2 effects, same id |
| post-settle, latency 2.5 s | — | — | 22.8 s | call 1 `abandoned`, mock re-call |

Results inside the sandbox match the local runs (S3) for all three cases.

Budget implications (revises the earlier estimate of 1.2–1.5 min per lane): budget ≈ 35 s of Active CPU per crash cell (two `eve dev` startups on 2 vCPU; 18–40 s observed across all runs) plus ≈ 5–10 s per sandbox for install. A 6-cell lane ≈ 3–3.5 min CPU; a 5-tool audit ≈ 16–18 min without re-verification. Hobby's 5 h/month ≈ 15 such audits. Levers if needed: run all cells of a lane in one sandbox (one install), 1 vCPU, or reuse a warm `eve dev` for baselines.

## Notes for the engine (from the final review)

- Health detection: one slow health probe must not be treated as a dead server (it would make the harness kill the server and create a harness-made duplicate). Require consecutive failures or the dev child's exit, and record who killed the server.
- Every run summary must record its crash point, provider latency and marker (done in the spike driver), so evidence is self-identifying.
- POST requests need timeouts bounded by the run deadline; `--auto-approve` was never exercised in M0.
- `netstat` parsing depends on the English `LISTENING` token; use a locale-independent method on Windows.
- Wiping `.eve` deletes eve's dev cleanup intents; sandbox resources from killed runs should be reclaimed another way.
- Identity op-key assumes `ctx.session.turn.id` is stable across a replay and that identity fields are regenerated verbatim (only `to` was observed verbatim, 3/3); verify when building the engine.
- The fake provider should be able to answer "did this already happen?" lookups, so a check-before-act fix can be demonstrated and verified.
