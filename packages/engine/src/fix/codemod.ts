// Fix codemods. Each rewrites the `execute` of one tool file so that a replay after a crash does not repeat its
// side effect, with the idempotency helper it copies into the app as agent/lib/crashtest-idempotency.ts:
//
//   ledger-guard   return once(opKey(ctx, { <identity> }), defaultStore(), async () => { <original body> });
//   upstream-key   "Idempotency-Key": opKey(ctx, { <identity> }) on each fetch to a host that honors the header
//
// The op-key is built from the identity fields the caller names, never from ctx.callId or free text. Edits are
// splices at positions taken from the syntax tree, so the rest of the file keeps its formatting. A codemod
// applies completely or writes nothing and says why.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import type {
  ArrowFunction,
  CallExpression,
  FunctionExpression,
  MethodDeclaration,
  ObjectBindingPattern,
  ObjectLiteralExpression,
  SourceFile,
  ts,
} from "ts-morph";
import { templatePath } from "../paths.ts";
import { hostSupportsIdempotency } from "../preload/catalog.ts";
import type { ToolInfo } from "../types.ts";

export interface CodemodFile {
  /** App-relative, posix. */
  path: string;
  /** The exact original text, or null for a file the codemod created. */
  before: string | null;
  after: string;
}

export interface CodemodResult {
  applied: boolean;
  /** Why the codemod was not applied. */
  reason?: string;
  /** What was written; empty when the codemod was not applied. */
  files: CodemodFile[];
}

/** Where the helper goes. One that is already there is never overwritten: the user's edits win. */
const HELPER_FILE = "agent/lib/crashtest-idempotency.ts";
const HELPER_MODULE = HELPER_FILE.replace(/\.ts$/, "");
const LEDGER_GUARD_NAMES = ["defaultStore", "once", "opKey"];
const UPSTREAM_KEY_NAMES = ["opKey"];

/** Wraps the body of `execute` in `once`, so its side effect runs at most once per operation. */
export function applyLedgerGuard(appDir: string, tool: ToolInfo, identity: string[]): CodemodResult {
  return runCodemod(appDir, tool, (source) => {
    if (source.helperImports.has("once")) notApplied("already guarded");
    assertNamesFree(source, LEDGER_GUARD_NAMES);
    const fn = findExecute(source.sf);
    if (fn.compilerNode.asteriskToken) notApplied("execute is a generator");
    const binding = bindIdentity(source, fn, identity);
    return [...binding.edits, guardBody(source, fn, binding.key), importEdit(source, LEDGER_GUARD_NAMES)];
  });
}

/**
 * Sends an op-key as the Idempotency-Key of the fetch in `execute` to a host that honors the header. There must
 * be exactly one such call and it must run at most once per run of `execute`: the provider rejects a key reused
 * with a different body, so a second call, or the same call in a loop or a callback, cannot share the op-key.
 */
export function applyUpstreamKey(appDir: string, tool: ToolInfo, identity: string[]): CodemodResult {
  return runCodemod(appDir, tool, (source) => {
    assertNamesFree(source, UPSTREAM_KEY_NAMES);
    const fn = findExecute(source.sf);
    const [call, ...others] = idempotentFetchCalls(fn);
    if (!call) notApplied("no fetch call to an idempotency-capable host");
    if (others.length > 0) notApplied("several fetch calls to idempotency-capable hosts share one identity");
    if (mayRepeat(source, call.call, fn)) notApplied("fetch call to an idempotency-capable host inside a loop or callback");
    const binding = bindIdentity(source, fn, identity);
    assertReadsParameters(fn, binding);
    return [...binding.edits, keyHeader(source, call, binding.key), importEdit(source, UPSTREAM_KEY_NAMES)];
  });
}

// ---------------------------------------------------------------- running a codemod

/** A replacement of `text.slice(start, end)`. */
interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Source {
  /** App-relative posix path of the tool file. */
  path: string;
  /** The text of the file without a byte order mark: what positions in `sf` refer to. */
  text: string;
  sf: SourceFile;
  eol: string;
  /** The quote the file's imports use. */
  quote: string;
  /** Exported name → local name of each value imported from the helper. */
  helperImports: Map<string, string>;
}

class NotApplied extends Error {}

function notApplied(reason: string): never {
  throw new NotApplied(reason);
}

function runCodemod(appDir: string, tool: ToolInfo, edit: (source: Source) => (Edit | null)[]): CodemodResult {
  try {
    return applyCodemod(resolve(appDir), tool, edit);
  } catch (error) {
    if (error instanceof NotApplied) return { applied: false, reason: error.message, files: [] };
    throw error;
  }
}

/** Reads and checks the tool file, edits it, and writes it and the helper only once every check passed. */
function applyCodemod(root: string, tool: ToolInfo, edit: (source: Source) => (Edit | null)[]): CodemodResult {
  const file = resolve(root, tool.file);
  if (file === root || !contains(root, file)) notApplied(`tool file ${tool.file} is outside the app`);
  const path = relative(root, file).split(sep).join("/");
  let before: string;
  try {
    before = readFileSync(file, "utf8");
  } catch {
    notApplied(`cannot read tool file ${path}`);
  }
  if (!insideApp(root, file)) notApplied(`tool file ${tool.file} is outside the app`);

  const bom = before.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = before.slice(bom.length);
  const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
  const name = `/${posix.basename(path)}`;
  const sf = project.createSourceFile(name, text);
  if (!parses(project, sf)) notApplied(`tool file ${path} does not parse`);

  const edited = splice(text, edit(readSource(path, text, sf)).filter((e) => e !== null));
  if (edited === text) notApplied("already guarded");
  if (!parses(project, project.createSourceFile(name, edited, { overwrite: true }))) {
    notApplied(`the edited ${path} would not parse, so it was left as it is`);
  }

  const helper = resolve(root, HELPER_FILE);
  const createHelper = !existsSync(helper);
  if (createHelper && !insideApp(root, helper)) notApplied(`${HELPER_FILE} would be written outside the app`);

  const after = bom + edited;
  writeFileSync(file, after);
  const files: CodemodFile[] = [{ path, before, after }];
  if (createHelper) {
    mkdirSync(dirname(helper), { recursive: true });
    copyFileSync(templatePath("idempotency.ts"), helper);
    files.push({ path: HELPER_FILE, before: null, after: readFileSync(helper, "utf8") });
  }
  return { applied: true, files };
}

function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether `path` stays inside `root` also once the symbolic links in the part of it that exists are followed. */
export function insideApp(root: string, path: string): boolean {
  if (!contains(root, path)) return false;
  let existing = path;
  while (!existsSync(existing)) existing = dirname(existing);
  return contains(realpathSync(root), realpathSync(existing));
}

function parses(project: Project, sf: SourceFile): boolean {
  return project.getProgram().getSyntacticDiagnostics(sf).length === 0;
}

/** Applies non-overlapping edits, from the last one back, so earlier positions stay valid. */
function splice(text: string, edits: Edit[]): string {
  let out = text;
  let limit = Infinity;
  for (const e of edits.toSorted((a, b) => b.start - a.start)) {
    if (e.end > limit) throw new Error("codemod: overlapping edits");
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

function readSource(path: string, text: string, sf: SourceFile): Source {
  const helperImports = new Map<string, string>();
  for (const declaration of sf.getImportDeclarations()) {
    if (declaration.isTypeOnly() || !isHelperSpecifier(declaration.getModuleSpecifierValue(), path)) continue;
    for (const specifier of declaration.getNamedImports()) {
      if (!specifier.isTypeOnly()) helperImports.set(specifier.getName(), specifier.getAliasNode()?.getText() ?? specifier.getName());
    }
  }
  const firstSpecifier = sf.getImportDeclarations()[0]?.getModuleSpecifier().getText();
  return {
    path,
    text,
    sf,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    quote: firstSpecifier?.startsWith("'") ? "'" : '"',
    helperImports,
  };
}

function isHelperSpecifier(specifier: string, toolPath: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return false;
  return posix.join(posix.dirname(toolPath), specifier).replace(/\.[cm]?[jt]s$/, "") === HELPER_MODULE;
}

// ---------------------------------------------------------------- names

/** The codemod adds `names` to the file: a declaration of one, or an import of one from anywhere but the helper, is in the way. */
function assertNamesFree(source: Source, names: readonly string[]): void {
  for (const id of source.sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const name = id.getText();
    const parent = id.getParentOrThrow();
    if (!names.includes(name) || (parent.compilerNode as { name?: ts.Node }).name !== id.compilerNode) continue;
    if (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent)) {
      const from = parent.getFirstAncestorByKindOrThrow(SyntaxKind.ImportDeclaration).getModuleSpecifierValue();
      if (Node.isImportSpecifier(parent) && source.helperImports.get(parent.getName()) === name) continue;
      notApplied(`"${name}" is already imported from "${from}"`);
    }
    if (isDeclaration(parent)) notApplied(`"${name}" is already declared in the tool file`);
  }
}

function isDeclaration(node: Node): boolean {
  return (
    Node.isVariableDeclaration(node) ||
    Node.isParameterDeclaration(node) ||
    Node.isBindingElement(node) ||
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isClassDeclaration(node) ||
    Node.isClassExpression(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isImportEqualsDeclaration(node)
  );
}

/** Whether an identifier only names a property, so a variable of the same name does not shadow or replace it. */
function isPropertyName(id: Node): boolean {
  const parent = id.getParentOrThrow();
  const node = parent.compilerNode as { name?: ts.Node; propertyName?: ts.Node };
  if (node.propertyName === id.compilerNode) return true;
  return (
    node.name === id.compilerNode &&
    (Node.isPropertyAccessExpression(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isMethodDeclaration(parent) ||
      Node.isPropertyDeclaration(parent) ||
      Node.isGetAccessorDeclaration(parent) ||
      Node.isSetAccessorDeclaration(parent) ||
      Node.isPropertySignature(parent) ||
      Node.isMethodSignature(parent))
  );
}

/**
 * Picks names for the bindings a codemod adds to `execute`: the wanted name when nothing in `execute` refers to
 * it (so the new binding shadows nothing and clashes with nothing), else the first `<name>2`, `<name>3`, … that
 * the file does not use at all. The helper's names are never picked.
 */
function namePicker(sf: SourceFile, fn: Execute): (wanted: string) => string {
  const referenced = new Set<string>();
  for (const id of fn.getDescendantsOfKind(SyntaxKind.Identifier)) if (!isPropertyName(id)) referenced.add(id.getText());
  const inFile = new Set(sf.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  const taken = new Set(LEDGER_GUARD_NAMES);
  return (wanted) => {
    let name = wanted;
    for (let n = 2; referenced.has(name) || taken.has(name) || (name !== wanted && inFile.has(name)); n++) name = `${wanted}${n}`;
    taken.add(name);
    return name;
  };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// Words a binding cannot be named in a module.
const RESERVED = new Set(
  `arguments await break case catch class const continue debugger default delete do else enum eval export extends
  false finally for function if implements import in instanceof interface let new null package private protected
  public return static super switch this throw true try typeof var void while with yield`.split(/\s+/),
);

function isBindingName(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/** A binding name close to an input field name that may not be one, such as `order-id`. */
function bindingNameFor(field: string): string {
  const name = field.replace(/[^\w$]/g, "_");
  return isBindingName(name) ? name : `_${name}`;
}

function propertyKey(field: string): string {
  return IDENTIFIER.test(field) ? field : JSON.stringify(field);
}

function memberOf(object: string, field: string): string {
  return IDENTIFIER.test(field) ? `${object}.${field}` : `${object}[${JSON.stringify(field)}]`;
}

// ---------------------------------------------------------------- execute and its parameters

type Execute = MethodDeclaration | ArrowFunction | FunctionExpression;

function unwrap(node: Node | undefined): Node | undefined {
  while (node && Node.isParenthesizedExpression(node)) node = node.getExpression();
  return node;
}

/** The name of an object literal member or binding when it is written out: `headers`, `"headers"`, `["headers"]`. */
function staticName(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  if (Node.isComputedPropertyName(node)) {
    const expression = node.getExpression();
    return Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression) ? expression.getLiteralValue() : undefined;
  }
  if (
    Node.isPropertyAssignment(node) ||
    Node.isShorthandPropertyAssignment(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return staticName(node.getNameNode());
  }
  return undefined;
}

/** The object passed to the default-exported `defineTool(...)`. */
function defineToolOptions(sf: SourceFile): ObjectLiteralExpression | undefined {
  const call = unwrap(sf.getExportAssignment((e) => !e.isExportEquals())?.getExpression());
  if (!call || !Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  const isDefineTool =
    (Node.isIdentifier(callee) && callee.getText() === "defineTool") ||
    (Node.isPropertyAccessExpression(callee) && callee.getName() === "defineTool");
  const options = call.getArguments()[0];
  return isDefineTool && options && Node.isObjectLiteralExpression(options) ? options : undefined;
}

/** The `execute` member of the object passed to the default-exported `defineTool(...)`. */
function findExecute(sf: SourceFile): Execute {
  const options = defineToolOptions(sf);
  if (!options) notApplied("the default export is not a defineTool({...}) call");

  const member = options.getProperties().findLast((p) => staticName(p) === "execute");
  if (!member) notApplied("defineTool({...}) has no execute member");
  if (Node.isMethodDeclaration(member)) return member;
  const value = Node.isPropertyAssignment(member) ? unwrap(member.getInitializer()) : undefined;
  if (value && (Node.isArrowFunction(value) || Node.isFunctionExpression(value))) return value;
  notApplied("execute is not a method, an arrow function or a function expression");
}

interface Binding {
  /** Changes to the parameters of `execute`: identity fields added to a destructured input, a context parameter. */
  edits: Edit[];
  /** `opKey(<ctx>, { <field>: <value>, … })`, valid at the top of the body of `execute`. */
  key: string;
  /** The parameter names the key reads. Deeper in the body, a declaration of one of them would shadow it. */
  reads: string[];
}

/**
 * Makes the context and the identity fields of the input reachable in `execute`. An input parameter `p` gives
 * `p.<field>`; a destructured input gains the fields it lacks (a rest element supplies them instead, so what it
 * collects does not change); a missing context parameter is added.
 */
function bindIdentity(source: Source, fn: Execute, identity: string[]): Binding {
  const fields = [...new Set(identity)];
  const pick = namePicker(source.sf, fn);
  const [input, context] = fn.getParameters();
  const edits: Edit[] = [];
  const addedParameters: string[] = [];

  if (context && (context.isRestParameter() || !Node.isIdentifier(context.getNameNode()))) {
    notApplied("execute destructures its context");
  }

  // values: field → the expression the key reads it from; reads: the parameter names those expressions start with.
  let values: Map<string, string>;
  const reads = new Set<string>();
  if (!input) {
    const name = pick(fields.length > 0 ? "input" : "_input");
    addedParameters.push(name);
    values = new Map(fields.map((field) => [field, memberOf(name, field)]));
    if (fields.length > 0) reads.add(name);
  } else {
    const name = input.getNameNode();
    if (input.isRestParameter() || !(Node.isIdentifier(name) || Node.isObjectBindingPattern(name))) {
      notApplied("execute takes its input as neither a parameter name nor an object pattern");
    }
    if (Node.isIdentifier(name)) {
      values = new Map(fields.map((field) => [field, memberOf(name.getText(), field)]));
      if (fields.length > 0) reads.add(name.getText());
    } else {
      const destructured = bindFromPattern(source, name, fields, pick);
      values = destructured.values;
      for (const binding of destructured.reads) reads.add(binding);
      if (destructured.edit) edits.push(destructured.edit);
    }
  }

  let ctx = context?.getName();
  if (ctx === undefined) {
    ctx = pick("ctx");
    addedParameters.push(ctx);
  }
  reads.add(ctx);
  if (addedParameters.length > 0) edits.push(appendParameters(source, fn, addedParameters));

  const properties = fields.map((field) => {
    const value = values.get(field)!;
    return value === field ? field : `${propertyKey(field)}: ${value}`;
  });
  return { edits, key: `opKey(${ctx}, ${properties.length > 0 ? `{ ${properties.join(", ")} }` : "{}"})`, reads: [...reads] };
}

/**
 * upstream-key puts the key at the fetch call, not at the top of the body, so a name it reads must still mean the
 * parameter there. Refuses when the body of `execute` declares one of them again anywhere (a block-local `const`,
 * a `catch (ctx)`, a callback parameter), as the key would then read another value without anything noticing.
 */
function assertReadsParameters(fn: Execute, binding: Binding): void {
  for (const id of fn.getBody()?.getDescendantsOfKind(SyntaxKind.Identifier) ?? []) {
    const name = id.getText();
    const parent = id.getParentOrThrow();
    if (binding.reads.includes(name) && (parent.compilerNode as { name?: ts.Node }).name === id.compilerNode && isDeclaration(parent)) {
      notApplied(`"${name}" is declared again inside execute, so the key at the fetch call could read another value`);
    }
  }
}

function bindFromPattern(
  source: Source,
  pattern: ObjectBindingPattern,
  fields: string[],
  pick: (wanted: string) => string,
): { values: Map<string, string>; reads: string[]; edit: Edit | null } {
  const elements = pattern.getElements();
  const rest = elements.find((e) => e.getDotDotDotToken() !== undefined);
  const values = new Map<string, string>();
  const reads: string[] = [];
  const added: string[] = [];
  for (const field of fields) {
    const element = elements.find((e) => e !== rest && staticName(e.getPropertyNameNode() ?? e.getNameNode()) === field);
    if (element) {
      const name = element.getNameNode();
      if (!Node.isIdentifier(name)) notApplied(`execute destructures "${field}" into a nested pattern`);
      values.set(field, name.getText());
      reads.push(name.getText());
    } else if (rest) {
      values.set(field, memberOf(rest.getName(), field));
      reads.push(rest.getName());
    } else {
      const name = pick(bindingNameFor(field));
      added.push(name === field ? field : `${propertyKey(field)}: ${name}`);
      values.set(field, name);
      reads.push(name);
    }
  }
  return { values, reads, edit: added.length > 0 ? appendToBraces(source, pattern, elements, added) : null };
}

function appendParameters(source: Source, fn: Execute, names: string[]): Edit {
  const parameters = fn.getParameters();
  const open = fn.getFirstChildByKind(SyntaxKind.OpenParenToken);
  const close = fn.getFirstChildByKind(SyntaxKind.CloseParenToken);
  if (!open || !close) {
    // An arrow function with one parameter and no parentheses: `async input => …`.
    const only = parameters[0]!;
    return { start: only.getStart(), end: only.getEnd(), text: `(${[only.getText(), ...names].join(", ")})` };
  }
  return appendToList(source, open.getStart(), close.getStart(), parameters, names, "");
}

// ---------------------------------------------------------------- ledger-guard

const LITERAL_KINDS = new Set([
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
]);

/** Moves the body of `execute` into the function `once` runs, one indentation level deeper. */
function guardBody(source: Source, fn: Execute, key: string): Edit {
  const wrapper = `once(${key}, defaultStore(), async () => `;
  const body = fn.getBody();
  if (!body) notApplied("execute has no body");
  if (!Node.isBlock(body)) {
    const value = Node.isParenthesizedExpression(body) ? body.getText() : `(${body.getText()})`;
    return { start: body.getStart(), end: body.getEnd(), text: `${wrapper}${value})` };
  }

  const { text, eol } = source;
  const open = body.getStart();
  const close = body.getEnd() - 1;
  const inner = text.slice(open + 1, close);
  if (!inner.includes("\n")) return { start: open, end: close + 1, text: `{ return ${wrapper}{${inner}}); }` };

  // The statements keep their own lines; each line moves one level deeper unless it is blank or starts inside a
  // string or template literal, whose text must not change.
  const closeIndent = lineIndent(text, close);
  const firstCode = inner.search(/\S/);
  const codeIndent = firstCode !== -1 && /\n[ \t]*$/.test(inner.slice(0, firstCode)) ? lineIndent(text, open + 1 + firstCode) : null;
  const unit =
    codeIndent !== null && codeIndent.startsWith(closeIndent) && codeIndent.length > closeIndent.length
      ? codeIndent.slice(closeIndent.length)
      : closeIndent.includes("\t")
        ? "\t"
        : "  ";
  const indent = codeIndent ?? closeIndent + unit;
  const literals: [number, number][] = [];
  body.forEachDescendant((node) => {
    if (LITERAL_KINDS.has(node.getKind())) literals.push([node.getStart(), node.getEnd()]);
  });
  const inLiteral = (pos: number): boolean => literals.some(([start, end]) => start < pos && pos < end);
  const statements = inner
    .trimEnd()
    .replace(/\n(?![ \t]*(?:\r?\n|\r?$))/g, (newline, at: number) => (inLiteral(open + 1 + at + 1) ? newline : newline + unit));
  return { start: open, end: close + 1, text: `{${eol}${indent}return ${wrapper}{${statements}${eol}${indent}});${eol}${closeIndent}}` };
}

// ---------------------------------------------------------------- upstream-key

interface FetchCall {
  call: CallExpression;
  host: string;
}

function idempotentFetchCalls(fn: Execute): FetchCall[] {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).flatMap((call) => {
    const callee = call.getExpression();
    const url = call.getArguments()[0];
    if (!Node.isIdentifier(callee) || callee.getText() !== "fetch" || url === undefined) return [];
    const host = literalHost(url);
    return host !== null && hostSupportsIdempotency(host) ? [{ call, host }] : [];
  });
}

const LOOP_KINDS = new Set([
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
]);

/**
 * Whether `node` can run more than once per run of `execute`: inside a loop, or inside a function nested in
 * `execute` (a callback such as `.map(async …)`). The function ledger-guard hands to the helper's `once` is the
 * exception: it runs at most once per op-key.
 */
function mayRepeat(source: Source, node: Node, fn: Execute): boolean {
  for (let ancestor = node.getParent(); ancestor && ancestor !== fn; ancestor = ancestor.getParent()) {
    if (LOOP_KINDS.has(ancestor.getKind())) return true;
    if (Node.isFunctionLikeDeclaration(ancestor) && !isOnceCallback(source, ancestor)) return true;
  }
  return false;
}

function isOnceCallback(source: Source, node: Node): boolean {
  const once = source.helperImports.get("once");
  const call = node.getParent();
  return (
    once !== undefined &&
    call !== undefined &&
    Node.isCallExpression(call) &&
    call.getExpression().getText() === once &&
    call.getArguments().at(-1) === node
  );
}

/** The host of a URL written as a literal, or as a template literal whose fixed start holds the whole host. */
function literalHost(url: Node): string | null {
  let prefix: string;
  if (Node.isStringLiteral(url) || Node.isNoSubstitutionTemplateLiteral(url)) prefix = url.getLiteralValue();
  else if (Node.isTemplateExpression(url)) prefix = url.getHead().getLiteralText();
  else return null;
  const match = /^https:\/\/([^/?#]*)([/?#])?/i.exec(prefix);
  // In `https://api.stripe.com${path}` the substitution could still be part of the host.
  if (!match || (match[2] === undefined && Node.isTemplateExpression(url))) return null;
  try {
    return new URL(`https://${match[1]}/`).hostname;
  } catch {
    return null;
  }
}

function keyHeader(source: Source, { call, host }: FetchCall, key: string): Edit {
  const header = `${source.quote}Idempotency-Key${source.quote}: ${key}`;
  const [url, init] = call.getArguments();
  if (!init) return { start: url!.getEnd(), end: url!.getEnd(), text: `, { headers: { ${header} } }` };
  if (!Node.isObjectLiteralExpression(init)) notApplied(`a fetch call to ${host} passes options that are not an object literal`);
  const options = init.getProperties();
  if (options.some((p) => Node.isSpreadAssignment(p))) notApplied(`a fetch call to ${host} spreads its options, so its headers are unknown`);

  const headers = options.findLast((p) => staticName(p) === "headers");
  if (!headers) return appendToBraces(source, init, options, [`headers: { ${header} }`]);
  const value = Node.isPropertyAssignment(headers) ? headers.getInitializer() : undefined;
  if (!value || !Node.isObjectLiteralExpression(value)) notApplied(`a fetch call to ${host} passes headers that are not an object literal`);
  // Every header name must be known: one brought in by a spread or a computed name could be another spelling of
  // Idempotency-Key, and fetch would send both values joined.
  const fields = value.getProperties();
  if (fields.some((p) => Node.isSpreadAssignment(p))) {
    notApplied(`a fetch call to ${host} spreads its headers, so an Idempotency-Key among them is unknown`);
  }
  if (fields.some((p) => staticName(p) === undefined)) notApplied(`a fetch call to ${host} has a computed header name`);
  const existing = fields.filter((p) => staticName(p)?.toLowerCase() === "idempotency-key");
  if (existing.length > 1) notApplied(`a fetch call to ${host} sets Idempotency-Key more than once`);
  if (existing[0]) return { start: existing[0].getStart(), end: existing[0].getEnd(), text: header };
  return appendToBraces(source, value, fields, [header]);
}

// ---------------------------------------------------------------- imports and lists

/** Imports what `names` lacks from the helper: into an import of it that is already there, else as a new import. */
function importEdit(source: Source, names: readonly string[]): Edit | null {
  const missing = names.filter((name) => source.helperImports.get(name) !== name);
  if (missing.length === 0) return null;
  const declarations = source.sf.getImportDeclarations();
  for (const declaration of declarations) {
    if (declaration.isTypeOnly() || !isHelperSpecifier(declaration.getModuleSpecifierValue(), source.path)) continue;
    const named = declaration.getImportClause()?.getNamedBindings();
    if (named && Node.isNamedImports(named)) return appendToBraces(source, named, named.getElements(), missing);
  }

  const specifiers = declarations.map((d) => d.getModuleSpecifierValue());
  const extension = specifiers.some((s) => (s.startsWith("./") || s.startsWith("../")) && s.endsWith(".ts")) ? ".ts" : "";
  const path = posix.relative(posix.dirname(source.path), HELPER_MODULE) + extension;
  const specifier = path.startsWith("../") ? path : `./${path}`;
  const last = declarations.at(-1);
  const semicolon = last && !last.getText().endsWith(";") ? "" : ";";
  const statement = `import { ${missing.join(", ")} } from ${source.quote}${specifier}${source.quote}${semicolon}`;
  if (last) {
    const at = endOfLine(source.text, last.getEnd()) ?? last.getEnd();
    return { start: at, end: at, text: `${source.eol}${statement}` };
  }
  const at = source.sf.getStatements()[0]!.getStart(true);
  return { start: at, end: at, text: `${statement}${source.eol}${source.eol}` };
}

/** Appends `items` to the list between the first and the last character of `node`, its `{` and `}`. */
function appendToBraces(source: Source, node: Node, elements: readonly Node[], items: string[]): Edit {
  return appendToList(source, node.getStart(), node.getEnd() - 1, elements, items, " ");
}

/**
 * Appends `items` to the comma-separated list between the brackets at `open` and `close`, in the list's layout:
 * a line each when its last element ends a line, else on that element's line, with a trailing comma if it has one.
 * `pad` goes inside the brackets of a list that was empty.
 */
function appendToList(source: Source, open: number, close: number, elements: readonly Node[], items: string[], pad: string): Edit {
  const { text, eol } = source;
  const last = elements.at(-1);
  if (!last) {
    const list = items.join(", ");
    return text.slice(open + 1, close).trim() === ""
      ? { start: open + 1, end: close, text: `${pad}${list}${pad}` }
      : { start: open + 1, end: open + 1, text: `${pad}${list}` };
  }

  const comma = skipTrivia(text, last.getEnd());
  const trailingComma = text[comma] === ",";
  const after = trailingComma ? comma + 1 : last.getEnd();
  const lineEnd = endOfLine(text, after);
  if (lineEnd === null) {
    const list = items.join(", ");
    return { start: after, end: after, text: trailingComma ? ` ${list},` : `, ${list}` };
  }
  const indent = lineIndent(text, last.getStart());
  const list = items.join(`,${eol}${indent}`);
  return trailingComma
    ? { start: lineEnd, end: lineEnd, text: `${eol}${indent}${list},` }
    : { start: after, end: lineEnd, text: `,${text.slice(after, lineEnd)}${eol}${indent}${list}` };
}

const TRIVIA = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//y;
const LINE_REST = /[ \t]*(?:\/\/[^\r\n]*)?(?=\r?\n)/y;
const INDENT = /[ \t]*/y;

/** The position after the whitespace and comments at `pos`. */
function skipTrivia(text: string, pos: number): number {
  TRIVIA.lastIndex = pos;
  while (TRIVIA.exec(text)) pos = TRIVIA.lastIndex;
  return pos;
}

/** The position of the line break after `pos` when only blanks and a line comment are left before it, else null. */
function endOfLine(text: string, pos: number): number | null {
  LINE_REST.lastIndex = pos;
  return LINE_REST.exec(text) ? LINE_REST.lastIndex : null;
}

function lineIndent(text: string, pos: number): string {
  INDENT.lastIndex = text.lastIndexOf("\n", pos - 1) + 1;
  return INDENT.exec(text)![0];
}
