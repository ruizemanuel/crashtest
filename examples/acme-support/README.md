# acme-support

A deliberately unprotected eve agent for Crashtest demos. It plays the customer support agent of Acme, a made-up
online store, with six tools. Each tool has a different crash-recovery flaw, or none, so the agent shows every rating
that crashtest gives: `crashtest run` rates the agent 1 star, `crashtest fix` patches every tool rated below 5 stars,
and a second `run` rates every evaluated tool 5 stars. The flaws are the point, so do not use this app
as a starting point for a real agent.

`agent/agent.ts` names a real model (`anthropic/claude-haiku-5.5`, capped at 4,000 output tokens or US$0.02 per
usage window), but crashtest never calls it: its lab replaces the model with a scripted mock, and a fake provider
answers every request, so a crashtest run spends no tokens and sends nothing to Stripe, Slack, Resend or GitHub.

## Tools

| Tool | What it does | What it demonstrates | Rating in the lab | Fix that `crashtest fix` chooses |
| --- | --- | --- | --- | --- |
| `refund_payment` | Refunds a charge: form `POST https://api.stripe.com/v1/refunds` | No idempotency key: a step that eve replays after a crash refunds twice. | ★☆☆☆☆ | `upstream-key`: an `Idempotency-Key` built from `chargeId`, `amount` and `reason`, which Stripe honors. |
| `post_slack_update` | Posts an order update with `POST https://slack.com/api/chat.postMessage`, after approval (`approval: always()`) | An approval gate does not stop a replay: the approved call posts twice. | ★★☆☆☆ | `ledger-guard`: Slack has no idempotency key, so `execute` runs at most once per `channel` and `orderId` in a turn. |
| `send_email` | Emails the customer with `POST https://api.resend.com/emails`, `Idempotency-Key: ctx.callId` | A key tied to the call id: a replay with the same id is deduplicated, but a call the model issues again gets a new id and sends a second email. | ★★★☆☆ | `ledger-guard`. `upstream-key` reaches only ★★★★☆: the model rewrites the subject and the body when it issues the call again, so the same key comes back with a different body, Resend answers 409 and the model gets an error for an email that was sent. |
| `upload_receipt` | Uploads the receipt with `PUT https://files.acme.test/receipts/<orderId>.pdf` and `If-None-Match: *`; any status but 200 throws | It never stores twice, but a repeat gets 412 and the model is told the upload failed although it happened. | ★★★★☆ | `ledger-guard`: a repeat gets the stored result, or `OUTCOME_UNKNOWN` when the first attempt was cut off. |
| `add_ticket_label` | Adds the label `refund` or `vip` to a GitHub issue | Idempotent by nature: adding a label the issue already has changes nothing. | ★★★★★ | None needed. |
| `lookup_order` | Reads an order with `GET https://api.acme.test/v1/orders/<orderId>` | Read-only: there is no effect to rate. | not evaluated | None. |

The agent rating is the lowest rating of its evaluated tools. Every tool sends `Authorization: Bearer
${process.env.<PROVIDER>_KEY ?? ""}` (`STRIPE_KEY`, `SLACK_KEY`, `RESEND_KEY`, `GITHUB_KEY`, `ACME_KEY`). The lab
removes those variables, so the token is empty there.

## Run crashtest on it

From the root of this repository, after `pnpm install`:

```sh
node packages/engine/src/cli.ts run --app examples/acme-support
```

`run` crash-tests every tool (about 45 `eve dev` runs, roughly 10 minutes) and writes
`examples/acme-support/.crashtest/report.md`, `report.json` and `badge.svg`. The last line it prints is the agent
rating, `Agent rating: ★☆☆☆☆ (1/5) · 5 of 6 tools evaluated · …`.

```sh
node packages/engine/src/cli.ts fix --all --app examples/acme-support --report examples/acme-support/.crashtest/report.json
```

`fix --all` tries both codemods on every tool rated 1 to 4 stars, each on its own lab copy, re-runs the tool's lane
there and keeps the candidate that improves the rating most. It writes `.crashtest/fix/<tool>.patch` and
`<tool>.json` and leaves the app as it is. `--report` takes the before ratings from the run above instead of new
lanes; crashtest ignores it, and says why, when it was made at another commit or on uncommitted changes, or when the
app has uncommitted changes now.

Add `--apply` to write each chosen patch into the app, then `run` again to see every evaluated tool at 5 stars. The
patches add `agent/lib/crashtest-idempotency.ts`. To put the example back for the next demo, run
`git checkout -- examples/acme-support` and delete `examples/acme-support/agent/lib/`.

The `ledger-guard` patches keep their records in files under `.crashtest-idempotency/` in the working directory of
`eve dev`; with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` set they use Upstash Redis instead. See
[the engine's README](../../packages/engine/README.md#crashtest-fix) for the trade-off of each strategy.

The engine's end-to-end test `packages/engine/test/e2e/acme.test.ts` runs `run`, `fix --all --apply` and `run` again
on a copy of this app and checks the ratings and strategies above.
