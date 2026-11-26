import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function resolveFromHere(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function readEngineVersion(): string {
  const pkg = JSON.parse(readFileSync(resolveFromHere("../package.json"), "utf8")) as { version: string };
  return pkg.version;
}

export const engineVersion: string = readEngineVersion();

/** Absolute path of the preload module: the .ts source when running from src/, the built .js from dist/. */
export function preloadPath(): string {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return resolveFromHere(`./preload/index.${ext}`);
}

/** Absolute path of a template directory; `../templates` is valid from both src/ and dist/. */
export function templatePath(name: string): string {
  return resolveFromHere(`../templates/${name}`);
}
