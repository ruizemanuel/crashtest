#!/usr/bin/env node
import { engineVersion } from "./paths.ts";

const USAGE = `crashtest ${engineVersion} - crash-test ratings for eve agents

Usage: crashtest <command> [options]

Commands:
  plan     discover the agent's tools and plan the crash cells
  run      crash-test every tool and write the report
  lane     crash-test a single tool
  fix      propose and verify a fix for a failing tool
  badge    render a rating badge from a report

Options:
  --version  print the version
  --help     print this help
`;

export async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "--version") {
    process.stdout.write(`${engineVersion}\n`);
    return 0;
  }
  if (command === undefined || command === "--help") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`crashtest: unknown command "${command}"\n\n${USAGE}`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
