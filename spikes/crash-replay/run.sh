#!/usr/bin/env bash
# SPIKE (throwaway). Usage: ./run.sh baseline | ./run.sh crash
set -u
cd "$(dirname "$0")"
MODE="${1:-baseline}"
export SPIKE_DIR="$(pwd -W 2>/dev/null || pwd)/.spike"
PORT=2077
URL="http://127.0.0.1:$PORT"

kill_port() {
  # Kill whatever Windows process listens on $PORT (node children survive bash kill).
  for pid in $(netstat -ano | grep -E "127.0.0.1:$PORT .*LISTENING|0.0.0.0:$PORT .*LISTENING" | awk '{print $5}' | sort -u); do
    taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
  done
}

start_dev() { # $1 = log file, $2.. extra flags
  local log="$1"; shift
  npx eve dev --no-ui --port "$PORT" "$@" > "$log" 2>&1 &
  DEV_PID=$!
  for i in $(seq 1 240); do
    grep -q '^\[DEV\] ready at ' "$log" 2>/dev/null && return 0
    kill -0 "$DEV_PID" 2>/dev/null || { echo "dev exited during startup:"; tail -30 "$log"; return 1; }
    sleep 0.5
  done
  echo "timeout waiting for ready"; tail -30 "$log"; return 1
}

alive() { curl -s -o /dev/null -m 2 "$URL/eve/v1/health" && return 0 || return 1; }

events() { # $1 session id
  curl -s -m 10 "$URL/eve/v1/session/$1/stream?follow=false" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      for (const line of s.split("\n").filter(Boolean)) {
        let e; try { e=JSON.parse(line); } catch { console.log("  RAW", line.slice(0,160)); continue; }
        if (!e.facts) continue;
        for (const f of e.facts) {
          const d=f.data||{}; const bits=[];
          if (d.callId) bits.push(`call=${d.callId}`);
          if (d.capability) bits.push(`cap=${JSON.stringify(d.capability).slice(0,60)}`);
          if (d.outcome) bits.push(`outcome=${d.outcome}`);
          if (d.error) bits.push(`error=${JSON.stringify(d.error).slice(0,200)}`);
          if (d.output!==undefined) bits.push(`output=${JSON.stringify(d.output).slice(0,120)}`);
          if (f.type==="content.completed") bits.push(`value=${JSON.stringify(d.value).slice(0,200)}`);
          console.log(`  ${f.type} ${bits.join(" ")}`);
        }
      }})'
}

rm -rf .spike .eve; mkdir -p .spike
kill_port
[ "$MODE" = "crash" ] && export SPIKE_CRASH=1 || export SPIKE_CRASH=0

echo "== start dev #1 (mode=$MODE)"
start_dev .spike/dev1.log || exit 1
RESP=$(curl -s -m 15 -X POST "$URL/eve/v1/session" -H "Content-Type: application/json" -d '{"message":"Send Alice a greeting"}')
echo "create: $RESP"
SID=$(echo "$RESP" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).sessionId??"")}catch{console.log("")}})')
echo "session: $SID"

# Wait for either the turn to settle or the server to die.
for i in $(seq 1 60); do
  sleep 1
  if ! alive; then echo "== server is DOWN after ${i}s"; break; fi
  if events "$SID" | grep -q "turn.settled"; then echo "== turn settled after ${i}s"; break; fi
done

if ! alive; then
  kill_port
  echo "== restart dev #2 with --resume"
  start_dev .spike/dev2.log --resume || exit 1
  for i in $(seq 1 60); do
    sleep 1
    if events "$SID" | grep -q "turn.settled"; then echo "== turn settled after restart (${i}s)"; break; fi
  done
fi

echo "== events"; events "$SID"
echo "== outbox (side effects) lines: $(wc -l < .spike/outbox.jsonl 2>/dev/null || echo 0)"
cat .spike/outbox.jsonl 2>/dev/null
echo "== crash marker: $(cat .spike/crashed.marker 2>/dev/null || echo none)"
kill_port
