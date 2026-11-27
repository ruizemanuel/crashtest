// Loads the optional `crashtest.config.json` that lives next to the agent under test. A typo in this file
// silently weakens a test, so the loader is strict: unknown top-level keys and wrongly typed sections are
// errors that name the offending key and file.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConfigError } from "./errors.ts";
import type { Fixture } from "./preload/fake-provider.ts";

/** The caller identity the lab channel gives a session (eve's `ctx.session.auth.current`), for tools that check it. */
export interface SessionAuth {
  authenticator: string;
  principalId: string;
  principalType: string;
  attributes?: Record<string, string | string[]>;
  issuer?: string;
  subject?: string;
}

export interface CrashtestConfig {
  scenarios?: Record<string, { input?: Record<string, unknown>; freeText?: string[]; auth?: SessionAuth }>;
  identity?: Record<string, string[]>;
  env?: Record<string, string>;
  fixtures?: Fixture[];
  effects?: { ignore?: string[] };
  waivers?: Record<string, string>;
  tools?: { exclude?: string[] };
  auth?: SessionAuth;
}

const CONFIG_FILE = "crashtest.config.json";
const SCENARIO_KEYS = ["input", "freeText", "auth"] as const;
const SESSION_AUTH_KEYS = ["authenticator", "principalId", "principalType", "attributes", "issuer", "subject"] as const;
const SESSION_AUTH_REQUIRED = ["authenticator", "principalId", "principalType"] as const;
const SESSION_AUTH_OPTIONAL = ["issuer", "subject"] as const;
const FIXTURE_KEYS = ["method", "url", "status", "body"] as const;
const ALLOWED_KEYS = ["scenarios", "identity", "env", "fixtures", "effects", "waivers", "tools", "auth"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function bad(path: string, what: string, expected: string): never {
  throw new ConfigError(`${path}: "${what}" must be ${expected}`);
}

/** Throws a ConfigError naming the first key of `body` that is not in `allowed`; `where` is the section path ("" at the top level). */
function rejectUnknownKeys(path: string, where: string, body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      const full = where === "" ? key : `${where}.${key}`;
      throw new ConfigError(`${path}: unknown key "${full}"; allowed keys: ${allowed.join(", ")}`);
    }
  }
}

/** The value as a plain object, or a ConfigError naming `what`. */
function objectOf(path: string, what: string, value: unknown): Record<string, unknown> {
  if (!isObject(value)) bad(path, what, "an object");
  return value;
}

function validateScenarios(path: string, value: unknown): void {
  for (const [tool, scenario] of Object.entries(objectOf(path, "scenarios", value))) {
    const where = `scenarios.${tool}`;
    const body = objectOf(path, where, scenario);
    rejectUnknownKeys(path, where, body, SCENARIO_KEYS);
    if ("input" in body) objectOf(path, `${where}.input`, body.input);
    if ("freeText" in body && !isStringArray(body.freeText)) bad(path, `${where}.freeText`, "an array of strings");
    if ("auth" in body) validateSessionAuth(path, `${where}.auth`, body.auth);
  }
}

/** A session identity at `where` (`auth` or `scenarios.<tool>.auth`): the shape of eve's `SessionAuthContext`. */
function validateSessionAuth(path: string, where: string, value: unknown): void {
  const body = objectOf(path, where, value);
  rejectUnknownKeys(path, where, body, SESSION_AUTH_KEYS);
  for (const key of SESSION_AUTH_REQUIRED) {
    if (typeof body[key] !== "string" || body[key] === "") bad(path, `${where}.${key}`, "a non-empty string");
  }
  for (const key of SESSION_AUTH_OPTIONAL) {
    if (key in body && typeof body[key] !== "string") bad(path, `${where}.${key}`, "a string");
  }
  if ("attributes" in body) {
    const valid = (entry: unknown): boolean => typeof entry === "string" || isStringArray(entry);
    validateStringMap(path, `${where}.attributes`, body.attributes, valid, "a string or an array of strings");
  }
}

function validateStringMap(path: string, section: string, value: unknown, valid: (entry: unknown) => boolean, expected: string): void {
  for (const [key, entry] of Object.entries(objectOf(path, section, value))) {
    if (!valid(entry)) bad(path, `${section}.${key}`, expected);
  }
}

function validateFixtures(path: string, value: unknown): void {
  if (!Array.isArray(value)) bad(path, "fixtures", "an array of fixtures");
  value.forEach((fixture, index) => {
    const where = `fixtures[${index}]`;
    const body = objectOf(path, where, fixture);
    rejectUnknownKeys(path, where, body, FIXTURE_KEYS);
    if (typeof body.url !== "string") bad(path, `${where}.url`, "a string");
    if ("method" in body && typeof body.method !== "string") bad(path, `${where}.method`, "a string");
    if ("status" in body && !Number.isInteger(body.status)) bad(path, `${where}.status`, "an integer");
  });
}

function validateStringListSection(path: string, section: string, key: string, value: unknown): void {
  const body = objectOf(path, section, value);
  rejectUnknownKeys(path, section, body, [key]);
  if (key in body && !isStringArray(body[key])) bad(path, `${section}.${key}`, "an array of strings");
}

function validate(path: string, parsed: unknown): CrashtestConfig {
  const config = objectOf(path, "the config file", parsed);
  rejectUnknownKeys(path, "", config, ALLOWED_KEYS);
  if ("scenarios" in config) validateScenarios(path, config.scenarios);
  if ("identity" in config) validateStringMap(path, "identity", config.identity, isStringArray, "an array of strings");
  if ("env" in config) validateStringMap(path, "env", config.env, (entry) => typeof entry === "string", "a string");
  if ("fixtures" in config) validateFixtures(path, config.fixtures);
  if ("effects" in config) validateStringListSection(path, "effects", "ignore", config.effects);
  if ("waivers" in config) validateStringMap(path, "waivers", config.waivers, (entry) => typeof entry === "string", "a string");
  if ("tools" in config) validateStringListSection(path, "tools", "exclude", config.tools);
  if ("auth" in config) validateSessionAuth(path, "auth", config.auth);
  return config as CrashtestConfig;
}

/** The session identity for `tool`: its own `scenarios.<tool>.auth`, else the top-level `auth`. */
export function sessionAuthFor(config: CrashtestConfig, tool: string): SessionAuth | undefined {
  const scenarios = config.scenarios;
  const own = scenarios !== undefined && Object.hasOwn(scenarios, tool) ? scenarios[tool]?.auth : undefined;
  return own ?? config.auth;
}

/**
 * Reads `<appDir>/crashtest.config.json`, or `explicitPath` (relative to the current directory) when given.
 * A missing default file is an empty config; a missing explicit file is an error, because the caller asked for it.
 */
export function loadConfig(appDir: string, explicitPath?: string): CrashtestConfig {
  const path = explicitPath === undefined ? join(appDir, CONFIG_FILE) : resolve(process.cwd(), explicitPath);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && explicitPath === undefined) return {};
    const reason = code === "ENOENT" ? "file not found" : `cannot read file (${(err as Error).message})`;
    throw new ConfigError(`${path}: ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ""));
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${(err as Error).message})`);
  }
  return validate(path, parsed);
}
