// The type check of a fix patch, and the module settings the patch's import follows. Both read <root>/tsconfig.json
// with the compiler's own reader, so comments and `extends` work. An app without one is not checked.
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { Project, ts } from "ts-morph";

/**
 * A module that cannot be found (2307), a name that needs a type package (2580, 2591) and a module without types
 * (7016): what is installed where the check runs is not the patch's doing, so the lab cannot judge these.
 */
const IGNORED_CODES = new Set([2307, 2580, 2591, 7016]);

function readTsconfig(root: string): ts.ParsedCommandLine | null {
  const file = join(root, "tsconfig.json");
  if (!existsSync(file)) return null;
  const { config } = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
  return ts.parseJsonConfigFileContent(config ?? {}, ts.sys, root, undefined, file);
}

/**
 * Whether the app resolves imports the way Node does (`module` or `moduleResolution` is `node16` or `nodenext`),
 * where a relative import needs its file extension, and whether it may write `.ts` for it. Null without a tsconfig.json.
 */
export function readModuleSettings(root: string): { nodeEsm: boolean; tsExtensions: boolean } | null {
  const options = readTsconfig(resolve(root))?.options;
  if (!options) return null;
  const { module, moduleResolution } = options;
  return {
    nodeEsm:
      module === ts.ModuleKind.Node16 ||
      module === ts.ModuleKind.NodeNext ||
      moduleResolution === ts.ModuleResolutionKind.Node16 ||
      moduleResolution === ts.ModuleResolutionKind.NodeNext,
    tsExtensions: options.allowImportingTsExtensions === true,
  };
}

interface Found {
  path: string;
  start: number;
  /** What two runs of the compiler compare: the file, the code and the message, not the position. */
  key: string;
  line: string;
}

/**
 * The type errors that `edits` add to the project of `<root>/tsconfig.json`: one `"<path>: <message>"` line for
 * each diagnostic of the whole project with the edits that it did not have without them. An edit's `path` is posix
 * and relative to `root`; an edit to a missing file creates it. Null when the app has no tsconfig.json.
 */
export function newTypeErrors(root: string, edits: { path: string; text: string }[]): string[] | null {
  const dir = resolve(root);
  const config = readTsconfig(dir);
  if (!config) return null;

  const project = new Project({ compilerOptions: config.options });
  for (const file of config.fileNames) project.addSourceFileAtPathIfExists(file);
  const files = edits.map((edit) => join(dir, ...edit.path.split("/")));
  // The edited files are checked with and without the edits, also when the tsconfig does not include them.
  for (const file of files) project.addSourceFileAtPathIfExists(file);

  const before = new Map<string, number>();
  for (const found of errors(dir, project)) before.set(found.key, (before.get(found.key) ?? 0) + 1);
  edits.forEach((edit, i) => project.createSourceFile(files[i]!, edit.text, { overwrite: true }));
  const added = errors(dir, project).filter((found) => {
    const count = before.get(found.key) ?? 0;
    if (count === 0) return true;
    before.set(found.key, count - 1);
    return false;
  });

  // The errors of the edited files come first, in the order of the edits, then those of other files by path; each
  // file's by position. So the first line is about the first edit whenever that edit broke something.
  const editPaths = files.map((file) => appPath(dir, file));
  const rank = (path: string): number => {
    const i = editPaths.indexOf(path);
    return i === -1 ? editPaths.length : i;
  };
  added.sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.start - b.start);
  return added.map((found) => found.line);
}

function errors(root: string, project: Project): Found[] {
  return project
    .getPreEmitDiagnostics()
    .map((diagnostic) => diagnostic.compilerObject)
    .filter((diagnostic) => !IGNORED_CODES.has(diagnostic.code))
    .map((diagnostic) => {
      // A diagnostic without a file is about the compiler options.
      const path = diagnostic.file ? appPath(root, diagnostic.file.fileName) : "tsconfig.json";
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n").replace(/\s*\n\s*/g, " ");
      return { path, start: diagnostic.start ?? 0, key: `${path}|${diagnostic.code}|${message}`, line: `${path}: ${message}` };
    });
}

/** The posix path of `file` relative to `root`. The compiler's file names use `/` on Windows too; `relative` reads both. */
function appPath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}
