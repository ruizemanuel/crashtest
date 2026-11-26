import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../../src/config.ts";
import { ConfigError } from "../../src/errors.ts";

function appWith(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "crashtest-config-"));
  if (text !== undefined) writeFileSync(join(dir, "crashtest.config.json"), text);
  return dir;
}

function withApp<T>(text: string | undefined, fn: (dir: string) => T): T {
  const dir = appWith(text);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config: missing file is empty", () => {
  withApp(undefined, (dir) => assert.deepEqual(loadConfig(dir), {}));
});

test("config: unknown key names allowed keys", () => {
  withApp(JSON.stringify({ scenario: {} }), (dir) => {
    assert.throws(
      () => loadConfig(dir),
      (err: unknown) =>
        err instanceof ConfigError &&
        /unknown key "scenario".*scenarios, identity, env, fixtures, effects, waivers, tools/.test(err.message),
    );
  });
});

test("config: bad JSON names the file", () => {
  withApp("{ nope", (dir) => {
    assert.throws(
      () => loadConfig(dir),
      (err: unknown) => err instanceof ConfigError && /crashtest\.config\.json/.test(err.message),
    );
  });
});

test("config: a valid file round-trips", () => {
  const config = {
    scenarios: { send_email: { input: { to: "bob" }, freeText: ["body"] } },
    identity: { send_email: ["to", "subject"] },
    env: { STRIPE_KEY: "sk_test_x" },
    fixtures: [{ method: "GET", url: "https://api.example.test/*", status: 200, body: { ok: true } }],
    effects: { ignore: ["GET api.example.test/health"] },
    waivers: { send_email: "sends to a sandbox inbox" },
    tools: { exclude: ["lookup"] },
  };
  withApp(JSON.stringify(config), (dir) => assert.deepEqual(loadConfig(dir), config));
});

test("config: a UTF-8 byte order mark is tolerated", () => {
  withApp("﻿" + JSON.stringify({ env: { A: "1" } }), (dir) => assert.deepEqual(loadConfig(dir), { env: { A: "1" } }));
});

test("config: wrong section types name the section", () => {
  const bad: Array<[string, unknown]> = [
    ["scenarios", []],
    ["scenarios", { t: { input: "x" } }],
    ["scenarios", { t: { freeText: "body" } }],
    ["identity", { t: "to" }],
    ["env", { A: 1 }],
    ["fixtures", { url: "x" }],
    ["fixtures", [{ status: 200 }]],
    ["effects", { ignore: "x" }],
    ["waivers", { t: 3 }],
    ["tools", { exclude: [1] }],
  ];
  for (const [section, value] of bad) {
    withApp(JSON.stringify({ [section]: value }), (dir) => {
      assert.throws(
        () => loadConfig(dir),
        (err: unknown) => err instanceof ConfigError && err.message.includes(`"${section}`),
        `${section}: ${JSON.stringify(value)}`,
      );
    });
  }
});

test("config: a top-level value that is not an object is rejected", () => {
  for (const text of ["[]", "null", "42"]) {
    withApp(text, (dir) => assert.throws(() => loadConfig(dir), ConfigError));
  }
});

test("config: an explicit path overrides the default and may be relative to the cwd", () => {
  withApp(JSON.stringify({ env: { DEFAULT: "1" } }), (dir) => {
    const other = join(dir, "other.json");
    writeFileSync(other, JSON.stringify({ env: { OTHER: "1" } }));
    assert.deepEqual(loadConfig(dir, other), { env: { OTHER: "1" } });
    const relative = join(".", "other.json");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      assert.deepEqual(loadConfig(join(dir, "elsewhere"), relative), { env: { OTHER: "1" } });
    } finally {
      process.chdir(previous);
    }
  });
});

test("config: an explicit path that does not exist is an error", () => {
  withApp(undefined, (dir) => {
    assert.throws(
      () => loadConfig(dir, join(dir, "missing.json")),
      (err: unknown) => err instanceof ConfigError && /missing\.json/.test(err.message),
    );
  });
});

test("config: a directory in place of the file is an error", () => {
  withApp(undefined, (dir) => {
    mkdirSync(join(dir, "crashtest.config.json"));
    assert.throws(() => loadConfig(dir), ConfigError);
  });
});

function assertUnknownKey(config: unknown, pattern: RegExp): void {
  withApp(JSON.stringify(config), (dir) => {
    assert.throws(
      () => loadConfig(dir),
      (err: unknown) => err instanceof ConfigError && pattern.test(err.message),
      JSON.stringify(config),
    );
  });
}

test("config: a misspelled key in tools names its full path", () => {
  assertUnknownKey({ tools: { excludes: ["x"] } }, /unknown key "tools\.excludes"; allowed keys: exclude$/);
});

test("config: a misspelled key in effects names its full path", () => {
  assertUnknownKey({ effects: { ingore: ["x"] } }, /unknown key "effects\.ingore"; allowed keys: ignore$/);
});

test("config: a misspelled key in a scenario names its full path", () => {
  assertUnknownKey({ scenarios: { t: { freetext: ["x"] } } }, /unknown key "scenarios\.t\.freetext"; allowed keys: input, freeText$/);
  assertUnknownKey({ scenarios: { t: { inputs: {} } } }, /unknown key "scenarios\.t\.inputs"; allowed keys: input, freeText$/);
});

test("config: a misspelled key in a fixture names its full path", () => {
  assertUnknownKey(
    { fixtures: [{ url: "x" }, { url: "y", statuscode: 200 }] },
    /unknown key "fixtures\[1\]\.statuscode"; allowed keys: method, url, status, body$/,
  );
});
