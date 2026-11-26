# spikes/lib — crash driver (throwaway)

`node spikes/lib/drive.mjs --app <dir> --port <n> --message "<text>" [--expect-crash] [--auto-approve] [--timeout-s 120]`

Starts `eve dev --no-ui`, sends one message over the eve HTTP API, restarts with `--resume` if the server dies, and prints one JSON summary (`sessionId, serverDied, restarted, turnOutcome, calls, ledger, wallMs, logs`). Sets `CT_RUN_DIR=<app>/.ct-run` and `CT_LEDGER=<CT_RUN_DIR>/ledger.jsonl` for the app. Linux/macOS share one POSIX path (`lsof`/`fuser`); Windows uses `netstat`/`taskkill`.

Self-check: `node spikes/lib/check-driver.mjs` (checks A–D).
