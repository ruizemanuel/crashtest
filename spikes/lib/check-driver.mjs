// SPIKE: assertion script for spikes/lib/drive.mjs (checks A-D).
// Usage: node spikes/lib/check-driver.mjs [A|B|C|D ...]   (default: all)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const DRIVER = join(ROOT, "spikes", "lib", "drive.mjs");
const HEALTHY = join(ROOT, "spikes", "crash-replay");
const BROKEN = join(ROOT, "spikes", "lib", "fixtures", "broken");
const which = process.argv.slice(2);
const want = (c) => which.length === 0 || which.includes(c);
let failures = 0;

function drive(args, env = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [DRIVER, ...args], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 420_000,
  });
  let summary = null;
  try { summary = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? ""); } catch {}
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, summary, ms: Date.now() - t0 };
}
function assert(name, cond, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function portListening(port) {
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    return new RegExp(`(127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1?\\]):${port}\\s.*LISTENING`).test(r.stdout);
  }
  const r = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  return r.stdout.trim().length > 0;
}

if (!existsSync(DRIVER)) { console.log(`FAIL driver missing: ${DRIVER}`); process.exit(1); }

if (want("A")) {
  const r = drive(["--app", BROKEN, "--port", "2081", "--message", "hi", "--timeout-s", "90"]);
  assert("A: broken app exits 1", r.code === 1, `exit=${r.code}`);
  assert("A: within 120s", r.ms < 120_000, `${r.ms}ms`);
  assert("A: stderr shows dev log tail", /error|Error|ERR/.test(r.stderr), r.stderr.slice(-200).replace(/\s+/g, " "));
}

if (want("B") || want("C")) {
  const args = ["--app", HEALTHY, "--port", "2082", "--message", "Send Alice a greeting"];
  const r1 = drive(args, { SPIKE_CRASH: "0" });
  const r2 = drive(args, { SPIKE_CRASH: "0" });
  for (const [i, r] of [r1, r2].entries()) {
    const s = r.summary;
    assert(`B/C run${i + 1}: exit 0 with summary`, r.code === 0 && !!s, `exit=${r.code} ${r.stderr.slice(-200)}`);
    assert(`B/C run${i + 1}: turn completed`, s?.turnOutcome === "completed", s?.turnOutcome);
    assert(`B/C run${i + 1}: one call`, s?.calls?.length === 1, JSON.stringify(s?.calls));
    assert(`B/C run${i + 1}: server did not die`, s?.serverDied === false);
  }
  assert("C: fresh session per run", !!r1.summary?.sessionId && r1.summary?.sessionId !== r2.summary?.sessionId);
  assert("B: port 2082 free after runs", !portListening(2082));
}

if (want("D")) {
  rmSync(join(HEALTHY, ".spike"), { recursive: true, force: true });
  const r = drive(["--app", HEALTHY, "--port", "2083", "--message", "Send Alice a greeting", "--expect-crash"], { SPIKE_CRASH: "1" });
  const s = r.summary;
  assert("D: exit 0 with summary", r.code === 0 && !!s, `exit=${r.code} ${r.stderr.slice(-200)}`);
  assert("D: turn completed after crash", s?.turnOutcome === "completed", s?.turnOutcome);
  const outbox = existsSync(join(HEALTHY, ".spike", "outbox.jsonl"))
    ? readFileSync(join(HEALTHY, ".spike", "outbox.jsonl"), "utf8").trim().split("\n").length : 0;
  assert("D: duplicate side effect (outbox=2)", outbox === 2, `outbox=${outbox}`);
  console.log(`INFO D: serverDied=${s?.serverDied} restarted=${s?.restarted}`);
  assert("D: port 2083 free after run", !portListening(2083));
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
