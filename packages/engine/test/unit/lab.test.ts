import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { EngineError } from "../../src/errors.ts";
import { preloadImportFlag } from "../../src/driver/process.ts";
import { createLab, labEnv, preloadedLabEnv, removeLab } from "../../src/lab.ts";
import { preloadPath } from "../../src/paths.ts";

const EVE_STUB = JSON.stringify({ name: "eve", version: "1.5.0", bin: { eve: "bin/eve.js" } });

function put(root: string, rel: string, content = rel): void {
  const file = join(root, ...rel.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** An app with the same files whether or not it is a git repo; `eve` is a stub so the lab can resolve it. */
function seedApp(app: string): void {
  put(app, "package.json", JSON.stringify({ name: "demo", type: "module" }));
  put(app, "a.ts");
  put(app, "src/deep/nested.ts");
  put(app, ".gitignore", "*.log\n");
  put(app, "c.log");
  put(app, ".env.local", "STRIPE_SECRET_KEY=sk_live_do_not_copy");
  put(app, "config/.env", "TOKEN=do_not_copy");
  put(app, "node_modules/eve/package.json", EVE_STUB);
  put(app, "node_modules/x/index.js");
  put(app, "packages/p/node_modules/y/index.js");
  put(app, ".crashtest/old.txt");
  put(app, ".eve/state.json");
  put(app, ".vercel/project.json");
  put(app, ".ct-run/r.json");
  put(app, ".spike/s.txt");
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
}

function withTemp(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "ct-lab-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Relative posix paths of every file under `dir`. */
function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return out.sort();
}

function hashTree(dir: string, skip: Set<string>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else {
        out[full.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

test("lab copies tracked + untracked, skips ignored, secrets and heavy dirs", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    put(app, "gone.ts");
    git(app, "init", "-q");
    git(app, "add", "-A"); // tracks everything except c.log, including the secret and the heavy directories
    rmSync(join(app, "gone.ts")); // tracked in the index but missing on disk
    put(app, "b.ts"); // untracked, not ignored

    const lab = createLab(app);

    assert.equal(lab.labDir, join(app, ".crashtest", "lab"));
    assert.deepEqual(listFiles(lab.labDir), [".gitignore", "a.ts", "b.ts", "package.json", "src/deep/nested.ts"]);
    assert.equal(readFileSync(join(lab.labDir, "src", "deep", "nested.ts"), "utf8"), "src/deep/nested.ts");
  });
});

test("non-git app uses a walk with the same exclusions", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);

    const lab = createLab(app);

    // The walk has no ignore rules, so c.log is copied; every hard exclusion still applies.
    assert.deepEqual(listFiles(lab.labDir), [".gitignore", "a.ts", "c.log", "package.json", "src/deep/nested.ts"]);
  });
});

test("falls back to the walk when git lists nothing (app inside an ignored directory)", () => {
  withTemp((root) => {
    git(root, "init", "-q");
    put(root, ".gitignore", "ignored/\n");
    const app = join(root, "ignored", "app");
    seedApp(app);

    const lab = createLab(app);

    assert.deepEqual(listFiles(lab.labDir), [".gitignore", "a.ts", "c.log", "package.json", "src/deep/nested.ts"]);
  });
});

test("source tree is unchanged", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    git(app, "init", "-q");
    git(app, "add", "-A");
    put(app, "b.ts");
    const skip = new Set([".git", ".crashtest"]);
    const before = hashTree(app, skip);

    const lab = createLab(app);
    removeLab(lab);
    createLab(app);

    assert.deepEqual(hashTree(app, skip), before);
  });
});

test("outDir .gitignore", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);

    const lab = createLab(app);

    assert.equal(readFileSync(join(lab.outDir, ".gitignore"), "utf8"), "lab/\nlab-*/\nruns/\n");
    assert.equal(lab.outDir, join(app, ".crashtest"));
  });
});

test("lab resolves eve upward from the lab and reports its version and binary", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);

    const lab = createLab(app);

    assert.equal(lab.appDir, app);
    assert.equal(lab.eveVersion, "1.5.0");
    assert.equal(lab.eveBin, join(app, "node_modules", "eve", "bin", "eve.js"));
    assert.equal(existsSync(join(lab.labDir, "node_modules")), false);
  });
});

test("custom outDir and labDir are honored and the output directory is never copied into the lab", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    put(app, "out/runs/r1/report.json");
    const outDir = join(app, "out");
    const labDir = join(outDir, "lab-2");

    const lab = createLab(app, { outDir, labDir });

    assert.equal(lab.labDir, labDir);
    assert.deepEqual(listFiles(labDir), [".gitignore", "a.ts", "c.log", "package.json", "src/deep/nested.ts"]);
    assert.equal(readFileSync(join(outDir, ".gitignore"), "utf8"), "lab/\nlab-*/\nruns/\n");
  });
});

test("a lab outside the app is refused before anything is touched", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    const elsewhere = join(root, "elsewhere", "lab");
    mkdirSync(elsewhere, { recursive: true });
    put(elsewhere, "keep.txt");

    for (const labDir of [elsewhere, app]) {
      assert.throws(
        () => createLab(app, { labDir }),
        (err: unknown) => err instanceof EngineError && /must be inside/.test(err.message),
      );
    }
    assert.equal(existsSync(join(elsewhere, "keep.txt")), true);
    assert.equal(existsSync(join(app, "a.ts")), true);
  });
});

test("only a directory strictly inside the output directory is ever wiped", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    put(app, "out/runs/r1/report.json");
    const skip = new Set([".git"]);
    const before = hashTree(app, skip);

    const refused: { opts: { outDir?: string; labDir?: string }; what: string }[] = [
      { opts: { labDir: join(app, "src") }, what: "a source directory" },
      { opts: { labDir: join(app, "node_modules") }, what: "node_modules" },
      { opts: { labDir: join(app, ".crashtest") }, what: "the default output directory itself" },
      { opts: { outDir: join(app, "out"), labDir: join(app, "out") }, what: "the output directory itself" },
      { opts: { outDir: join(app, "out"), labDir: join(app, "src") }, what: "a source directory with a custom output directory" },
      { opts: { outDir: app }, what: "the app as the output directory" },
    ];
    for (const { opts, what } of refused) {
      assert.throws(
        () => createLab(app, opts),
        (err: unknown) => err instanceof EngineError && /must be inside/.test(err.message),
        what,
      );
    }
    assert.deepEqual(hashTree(app, skip), before, "nothing in the app changed");
    assert.equal(existsSync(join(app, ".crashtest", "lab")), false);
  });
});

test("removeLab refuses a lab that is not strictly inside its output directory", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);
    const real = createLab(app);
    const skip = new Set([".git"]);
    const before = hashTree(app, skip);

    const forged = [
      { ...real, labDir: join(app, "src") },
      { ...real, labDir: real.outDir },
      { ...real, labDir: app },
      { ...real, outDir: app, labDir: join(app, "src") },
      { ...real, outDir: join(root, "elsewhere"), labDir: join(root, "elsewhere", "lab") },
    ];
    for (const lab of forged) {
      assert.throws(
        () => removeLab(lab),
        (err: unknown) => err instanceof EngineError && /must be inside/.test(err.message),
      );
    }
    assert.deepEqual(hashTree(app, skip), before, "nothing in the app changed");
    assert.equal(existsSync(join(real.labDir, "a.ts")), true);
  });
});

test("creating a lab again wipes the previous one; removeLab deletes it", () => {
  withTemp((root) => {
    const app = join(root, "app");
    seedApp(app);

    const lab = createLab(app);
    put(lab.labDir, "stale.txt");
    put(lab.labDir, ".eve/state.json");
    const again = createLab(app);

    assert.equal(existsSync(join(again.labDir, "stale.txt")), false);
    assert.equal(existsSync(join(again.labDir, ".eve")), false);
    assert.equal(existsSync(join(again.labDir, "a.ts")), true);

    removeLab(again);
    assert.equal(existsSync(again.labDir), false);
    assert.equal(existsSync(join(app, "a.ts")), true);
    assert.doesNotThrow(() => removeLab(again));
  });
});

test("missing eve -> EngineError", () => {
  withTemp((root) => {
    const app = join(root, "app");
    put(app, "package.json", "{}");
    put(app, "a.ts");

    assert.throws(
      () => createLab(app),
      (err: unknown) => err instanceof EngineError && /eve is not installed/.test(err.message),
    );
    assert.equal(existsSync(join(app, ".crashtest", "lab")), false);
  });
});

test("labEnv scrubs credentials", () => {
  const env = labEnv(
    { PATH: "p", NODE_OPTIONS: "--x", STRIPE_SECRET_KEY: "s", AI_GATEWAY_API_KEY: "k", VERCEL_OIDC_TOKEN: "t", GH_TOKEN: "g" },
    { CT_RUN_DIR: "r", STRIPE_SECRET_KEY: "sk_test_fake" },
  );
  assert.deepEqual(env, { PATH: "p", NODE_OPTIONS: "--x", CT_RUN_DIR: "r", STRIPE_SECRET_KEY: "sk_test_fake" });
});

test("labEnv drops credential-looking names and provider prefixes, keeps ordinary variables", () => {
  const env = labEnv(
    {
      HOME: "/h",
      DB_PASSWORD: "1",
      pg_passwd: "2",
      AWS_CREDENTIALS: "3",
      SESSION_COOKIE: "4",
      ANTHROPIC_BASE_URL: "5",
      OPENAI_ORG: "6",
      VERCEL_ENV: "7",
      API_KEY: "8",
      EMPTY: undefined,
      NODE_OPTIONS: "--import=x",
    },
    {},
  );
  assert.deepEqual(env, { HOME: "/h", NODE_OPTIONS: "--import=x" });
});

test("labEnv drops values that carry URL credentials or name a database or queue server, whatever the variable is called", () => {
  const dropped = {
    DATABASE_URL: "postgres://app:hunter2@db.internal:5432/shop",
    POSTGRES_URL: "postgresql://db.internal/shop",
    PRISMA_URL: "prisma+postgres://accelerate.example/?api=1",
    MYSQL_URL: "mysql://root@localhost/shop",
    MARIADB: "mariadb://db/shop",
    MONGO: "mongodb+srv://cluster0.example.net/shop",
    MONGO_LOCAL: "mongodb://localhost:27017",
    KV_URL: "rediss://default:pw@kv.example:6379",
    REDIS_URL: "redis://localhost:6379",
    BROKER: "amqps://mq.example/vhost",
    RABBIT: "amqp://localhost",
    MAIL_SERVER: "smtp://mail.example:587",
    JDBC: "jdbc:sqlserver://db.example:1433;databaseName=shop",
    PROXY: "http://user:pass@proxy.example:8080",
    UPSTREAM: "https://:tok3n@api.example.com/v1",
  };
  const kept = {
    HOME: "/h",
    SITE_URL: "https://shop.example.com/orders",
    NPM_REPO: "git+https://github.com/acme/shop.git",
    MAILTO: "mailto:ops@example.com",
    NOTE: "redis is used in production",
    EMAIL: "ops@example.com",
  };
  assert.deepEqual(labEnv({ ...dropped, ...kept }, {}), kept);
});

test("labEnv keeps a connection string that the config env sets explicitly", () => {
  const env = labEnv({ DATABASE_URL: "postgres://app:hunter2@db.internal/shop" }, { DATABASE_URL: "postgres://localhost:5432/scratch" });
  assert.deepEqual(env, { DATABASE_URL: "postgres://localhost:5432/scratch" });
});

test("preloadedLabEnv scrubs credentials and stale CT_* variables, disables telemetry and appends the preload", () => {
  const flag = preloadImportFlag(preloadPath());
  const env = preloadedLabEnv(
    { PATH: "p", NODE_OPTIONS: "--max-old-space-size=2048", GH_TOKEN: "g", CT_FIXTURES: "stale.json", ct_crash_point: "post-settle" },
    { CT_RUN_DIR: "r", CT_CRASH_POINT: "none" },
  );
  assert.deepEqual(env, {
    PATH: "p",
    NODE_OPTIONS: `--max-old-space-size=2048 ${flag}`,
    CT_RUN_DIR: "r",
    CT_CRASH_POINT: "none",
    EVE_TELEMETRY_DISABLED: "1",
  });
});

test("preloadedLabEnv appends the preload to NODE_OPTIONS given in extra, or uses the flag alone", () => {
  const flag = preloadImportFlag(preloadPath());
  assert.equal(preloadedLabEnv({ NODE_OPTIONS: "--base" }, { NODE_OPTIONS: "--configured" }).NODE_OPTIONS, `--configured ${flag}`);
  assert.equal(preloadedLabEnv({}, {}).NODE_OPTIONS, flag);
});
