import assert from "node:assert/strict";
import { test } from "node:test";
import { HealthMonitor } from "../../src/driver/health.ts";

function monitor(probes: Array<boolean | "throw">, failuresToDead?: number): HealthMonitor {
  const queue = [...probes];
  return new HealthMonitor({
    probe: async () => {
      const next = queue.shift();
      if (next === "throw") throw new Error("connection refused");
      return next ?? false;
    },
    childExited: () => false,
    ...(failuresToDead === undefined ? {} : { failuresToDead }),
  });
}

async function run(m: HealthMonitor, n: number): Promise<string[]> {
  const states: string[] = [];
  for (let i = 0; i < n; i++) states.push(await m.check());
  return states;
}

test("one slow probe is not death", async () => {
  assert.deepEqual(await run(monitor([true, false, true, false, false]), 5), ["up", "down", "up", "down", "down"]);
});

test("three consecutive failures are death", async () => {
  assert.deepEqual(await run(monitor([false, false, false]), 3), ["down", "down", "dead"]);
});

test("child exit is immediate death", async () => {
  let probed = false;
  const m = new HealthMonitor({
    probe: async () => {
      probed = true;
      return true;
    },
    childExited: () => true,
  });
  assert.equal(await m.check(), "dead");
  assert.equal(probed, false, "no probe once the child is gone");
});

test("a throwing probe counts as a failure", async () => {
  assert.deepEqual(await run(monitor(["throw", "throw", "throw"]), 3), ["down", "down", "dead"]);
});

test("failuresToDead is configurable", async () => {
  assert.deepEqual(await run(monitor([false, false], 2), 2), ["down", "dead"]);
});

test("reset forgets earlier failures", async () => {
  const m = monitor([false, false, false, false]);
  assert.deepEqual(await run(m, 2), ["down", "down"]);
  m.reset();
  assert.deepEqual(await run(m, 2), ["down", "down"]);
});
