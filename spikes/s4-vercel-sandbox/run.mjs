// SPIKE (S4): run the S3 crash loop inside Vercel Sandbox and measure CPU.
// node --env-file .env.local run.mjs [crashPoint]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";

const POINT = process.argv[2] ?? "post-effect-fast";
const ROOT = resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", ".eve", ".ct-run", "results", ".spike"]);

function collect(dir, prefix) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p, prefix));
    else out.push({ path: `${prefix}/${relative(ROOT, p).replaceAll("\\", "/")}`, content: readFileSync(p) });
  }
  return out;
}

const files = [
  ...collect(join(ROOT, "s3-preload"), "ct"), // -> ct/s3-preload/...
  { path: "ct/lib/drive.mjs", content: readFileSync(join(ROOT, "lib", "drive.mjs")) },
  { path: "ct/lib/ports.mjs", content: readFileSync(join(ROOT, "lib", "ports.mjs")) },
];
const LATENCY = process.argv[3] ?? "0";

const t = {};
const mark = (k, t0) => { t[k] = Date.now() - t0; };
const sandbox = await Sandbox.create({
  image: "vercel/sandbox/node:24",
  resources: { vcpus: 2 },
  timeout: 15 * 60 * 1000,
  persistent: false,
});
let summary = null;
let error = null;
try {
  const home = (await (await sandbox.runCommand("pwd")).stdout()).trim();
  const app = `${home}/ct/s3-preload`;
  let t0 = Date.now();
  await sandbox.writeFiles(files);
  mark("upload", t0);

  t0 = Date.now();
  let install = await sandbox.runCommand({ cmd: "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: app });
  if (install.exitCode !== 0) {
    install = await sandbox.runCommand({ cmd: "npm", args: ["install", "--no-audit", "--no-fund"], cwd: app });
  }
  mark("install", t0);
  if (install.exitCode !== 0) throw new Error(`install failed: ${(await install.stderr()).slice(-800)}`);

  t0 = Date.now();
  const run = await sandbox.runCommand({
    cmd: "node",
    args: [`${home}/ct/lib/drive.mjs`, "--app", app, "--port", "2084", "--message", "Notify Alice", "--expect-crash", "--timeout-s", "240"],
    cwd: app,
    env: { CT_CRASH_POINT: POINT, CT_FAKE_LATENCY_MS: LATENCY, NODE_OPTIONS: `--import=${app}/preload.mjs` },
  });
  mark("run", t0);
  const stdout = (await run.stdout()).trim();
  try { summary = JSON.parse(stdout.split("\n").at(-1)); } catch { error = `no summary; exit=${run.exitCode}; stderr=${(await run.stderr()).slice(-1200)}`; }
} catch (e) {
  error = String(e?.stack ?? e);
} finally {
  await sandbox.stop().catch(() => {});
}

const cpu = { sessionActiveCpuMs: sandbox.activeCpuUsageMs, totalActiveCpuMs: sandbox.totalActiveCpuDurationMs, vcpus: sandbox.vcpus };
const result = {
  point: POINT, timingsMs: t, cpu, error,
  summary: summary && {
    turnOutcome: summary.turnOutcome, serverDied: summary.serverDied, restarted: summary.restarted,
    effects: summary.ledger.length, callIds: summary.ledger.map((l) => l.body?.callId), wallMs: summary.wallMs,
  },
};
writeFileSync(join(import.meta.dirname, "results", `run-${POINT}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
