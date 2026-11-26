import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineError } from "../../src/errors.ts";
import { detectPackageManager, installDependencies } from "../../src/package-manager.ts";

function withDir(files: string[], fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ct-pm-"));
  try {
    for (const f of files) writeFileSync(join(dir, f), "");
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("package manager detection: one case per lockfile", () => {
  withDir(["pnpm-lock.yaml"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), {
      name: "pnpm",
      lockfile: "pnpm-lock.yaml",
      install: ["pnpm", "install", "--frozen-lockfile"],
    }),
  );
  withDir(["package-lock.json"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), { name: "npm", lockfile: "package-lock.json", install: ["npm", "ci"] }),
  );
  withDir(["bun.lock"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), {
      name: "bun",
      lockfile: "bun.lock",
      install: ["bun", "install", "--frozen-lockfile"],
    }),
  );
  withDir(["bun.lockb"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), {
      name: "bun",
      lockfile: "bun.lockb",
      install: ["bun", "install", "--frozen-lockfile"],
    }),
  );
});

test("package manager detection: yarn berry (.yarnrc.yml) versus classic", () => {
  withDir(["yarn.lock", ".yarnrc.yml"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), { name: "yarn", lockfile: "yarn.lock", install: ["yarn", "install", "--immutable"] }),
  );
  withDir(["yarn.lock"], (dir) =>
    assert.deepEqual(detectPackageManager(dir), {
      name: "yarn",
      lockfile: "yarn.lock",
      install: ["yarn", "install", "--frozen-lockfile"],
    }),
  );
});

test("package manager detection: first match wins and no lockfile means null", () => {
  withDir(["package-lock.json", "yarn.lock", "bun.lock", "pnpm-lock.yaml"], (dir) =>
    assert.equal(detectPackageManager(dir)?.name, "pnpm"),
  );
  withDir(["package-lock.json", "yarn.lock"], (dir) => assert.equal(detectPackageManager(dir)?.name, "npm"));
  withDir(["package.json"], (dir) => assert.equal(detectPackageManager(dir), null));
});

test("installDependencies without a lockfile refuses with an actionable error", () => {
  withDir(["package.json"], (dir) =>
    assert.throws(
      () => installDependencies(dir),
      (err: unknown) =>
        err instanceof EngineError && err.message === `no lockfile in ${dir}: crashtest needs one for a reproducible install`,
    ),
  );
});
