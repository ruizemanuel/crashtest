// Child process for fs-effects.test.ts: installs the wrappers directly, with a `record` that itself writes files
// through the wrapped functions, and prints what was recorded. Usage: node fs-effects-child.mjs <lab> <runDir>.
import fs from "node:fs";
import { join } from "node:path";
import { installFsEffects } from "../../src/preload/fs-effects.ts";

const [lab, runDir] = process.argv.slice(2);
const recorded = [];

installFsEffects({
  labDir: lab,
  runDir,
  record(op, relPath, content) {
    recorded.push([op, relPath, content]);
    // A write made from inside `record` goes through the same wrapped functions and must not be observed (or recurse).
    fs.writeFileSync(join(lab, "from-record.txt"), "x");
    fs.appendFileSync(join(lab, "from-record.log"), "x\n");
  },
});

fs.writeFileSync(join(lab, "a.txt"), "a");
fs.appendFileSync(join(lab, "b.log"), "b\n");
await new Promise((resolve, reject) => fs.writeFile(join(lab, "c.txt"), "c", (error) => (error ? reject(error) : resolve())));
await new Promise((resolve, reject) => fs.appendFile(join(lab, "d.log"), "d\n", (error) => (error ? reject(error) : resolve())));
await fs.promises.writeFile(join(lab, "e.txt"), "e");
await fs.promises.appendFile(join(lab, "f.log"), "f\n");

process.stdout.write(`${JSON.stringify(recorded)}\n`);
