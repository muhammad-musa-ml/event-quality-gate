import { readFileSync, statSync, readdirSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Finding, FindingType } from './findings.js';
import { detectPii } from './pii.js';
import { getEvent, getProperty, matchesType } from './plan.js';
import type { PropertySpec, TrackingPlan } from './plan.js';

export const DEFAULT_TRACKERS: readonly string[] = ['track', 'analytics.track'];

const SOURCE_EXTENSIONS: Record<string, ts.ScriptKind> = {
  '.ts': ts.ScriptKind.TS,
  '.mts': ts.ScriptKind.TS,
  '.cts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
};
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'coverage']);

export interface SourceLintResult {
  /** Calls to a configured tracker. */
  calls: number;
  /** Calls whose event name is a string literal, so the plan could be consulted. */
  checked: number;
  /** Property values that are not literals (or are template strings with substitutions), so their value was not compared. */
  valuesNotChecked: number;
  findings: Finding[];
}

export interface PathLintResult {
  filesScanned: number;
  callsFound: number;
  callsChecked: number;
  valuesNotChecked: number;
  findings: Finding[];
}

type Literal =
  | { kind: 'known'; type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array'; value: unknown }
  | { kind: 'typed'; type: 'string' }
  | { kind: 'undefined' }
  | { kind: 'unknown' };

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/** `analytics?.track` and `this.analytics.track` become "analytics.track" and "this.analytics.track". */
function dottedName(e: ts.Expression): string | null {
  const x = unwrap(e);
  if (ts.isIdentifier(x)) return x.text;
  if (x.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(x)) {
    const left = dottedName(x.expression);
    return left === null ? null : `${left}.${x.name.text}`;
  }
  return null;
}

function stringLiteralText(e: ts.Expression): string | null {
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
}

function keyOf(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isNumericLiteral(name)) return String(Number(name.text));
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
    if (ts.isNumericLiteral(inner)) return String(Number(inner.text));
  }
  return null;
}

function literalOf(e: ts.Expression): Literal {
  const x = unwrap(e);
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return { kind: 'known', type: 'string', value: x.text };
  if (ts.isTemplateExpression(x)) return { kind: 'typed', type: 'string' };
  if (ts.isNumericLiteral(x)) return { kind: 'known', type: 'number', value: Number(x.text) };
  if (
    ts.isPrefixUnaryExpression(x) &&
    (x.operator === ts.SyntaxKind.MinusToken || x.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(x.operand)
  ) {
    const n = Number(x.operand.text);
    return { kind: 'known', type: 'number', value: x.operator === ts.SyntaxKind.MinusToken ? -n : n };
  }
  if (x.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'known', type: 'boolean', value: true };
  if (x.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'known', type: 'boolean', value: false };
  if (x.kind === ts.SyntaxKind.NullKeyword) return { kind: 'known', type: 'null', value: null };
  if (ts.isIdentifier(x) && x.text === 'undefined') return { kind: 'undefined' };
  if (ts.isObjectLiteralExpression(x)) return { kind: 'known', type: 'object', value: undefined };
  if (ts.isArrayLiteralExpression(x)) return { kind: 'known', type: 'array', value: undefined };
  return { kind: 'unknown' };
}

function describeLiteral(lit: Literal & { kind: 'known' }): string {
  switch (lit.type) {
    case 'string':
      return `string ${JSON.stringify(lit.value)}`;
    case 'number':
      return Number.isInteger(lit.value) ? `number ${String(lit.value)}` : `non-integer number ${String(lit.value)}`;
    case 'boolean':
      return `boolean ${String(lit.value)}`;
    default:
      return lit.type;
  }
}

class Collector {
  readonly findings: Finding[] = [];
  calls = 0;
  checked = 0;
  valuesNotChecked = 0;
  constructor(
    private readonly sf: ts.SourceFile,
    private readonly file: string,
  ) {}

  add(type: FindingType, node: ts.Node | number, message: string, extra: Partial<Finding> = {}): void {
    const pos = typeof node === 'number' ? node : node.getStart(this.sf);
    const lc = this.sf.getLineAndCharacterOfPosition(pos);
    this.findings.push({ type, message, file: this.file, line: lc.line + 1, column: lc.character + 1, ...extra });
  }
}

function checkValue(c: Collector, event: string, property: string, spec: PropertySpec | undefined, lit: Literal, node: ts.Node): void {
  if (lit.kind === 'undefined') return;
  if (lit.kind === 'unknown') {
    if (spec) c.valuesNotChecked++;
    return;
  }
  const where = { event, property };
  if (lit.kind === 'known' && lit.type === 'string' && spec?.pii !== true) {
    const shape = detectPii(lit.value as string);
    if (shape) c.add('pii-shaped-value', node, `property "${property}" of "${event}" gets a literal that looks like ${shape === 'email' ? 'an email address' : 'a phone number'}, and the plan does not declare it pii`, where);
  }
  if (!spec) return;
  if (lit.kind === 'typed') {
    if (spec.type !== 'string') {
      c.add('type-mismatch', node, `property "${property}" of "${event}" expects ${spec.type} but the value is a template string`, where);
    } else if (spec.enum) {
      c.valuesNotChecked++;
    }
    return;
  }
  if (!matchesType(spec.type, lit.value) || lit.type === 'null' || lit.type === 'object' || lit.type === 'array') {
    c.add('type-mismatch', node, `property "${property}" of "${event}" expects ${spec.type} but the literal is ${describeLiteral(lit)}`, where);
    return;
  }
  if (spec.enum && !spec.enum.includes(lit.value as string | number | boolean)) {
    c.add('enum-violation', node, `property "${property}" of "${event}" is ${JSON.stringify(lit.value)}, which is not in the plan's enum [${spec.enum.map((v) => JSON.stringify(v)).join(', ')}]`, where);
  }
}

function checkProperties(c: Collector, plan: TrackingPlan, event: string, call: ts.CallExpression): void {
  const spec = getEvent(plan, event);
  if (!spec) return;
  const arg = call.arguments[1];
  const argNode = arg === undefined ? undefined : unwrap(arg);
  const absent = argNode === undefined || (ts.isIdentifier(argNode) && argNode.text === 'undefined') || argNode.kind === ts.SyntaxKind.NullKeyword;
  if (!absent && !ts.isObjectLiteralExpression(argNode)) {
    c.add('unverifiable-properties', arg ?? call, `properties of "${event}" are not an object literal, so required and unexpected properties cannot be checked`, { event });
    return;
  }
  const present = new Set<string>();
  let opaque = false;
  if (argNode !== undefined && ts.isObjectLiteralExpression(argNode)) {
    for (const p of argNode.properties) {
      if (ts.isSpreadAssignment(p)) {
        opaque = true;
        continue;
      }
      const key = p.name === undefined ? null : keyOf(p.name);
      if (key === null) {
        opaque = true;
        continue;
      }
      let lit: Literal = { kind: 'unknown' };
      if (ts.isPropertyAssignment(p)) lit = literalOf(p.initializer);
      if (lit.kind !== 'undefined') present.add(key);
      const propSpec = getProperty(spec, key);
      if (!propSpec && lit.kind !== 'undefined') {
        c.add('unexpected-property', p.name, `property "${key}" is not declared for "${event}"`, { event, property: key });
      }
      checkValue(c, event, key, propSpec, lit, ts.isPropertyAssignment(p) ? p.initializer : p);
    }
    if (opaque) {
      c.add('unverifiable-properties', argNode, `properties of "${event}" include a spread or a computed key, so required and unexpected properties cannot be fully checked`, { event });
    }
  }
  if (!opaque) {
    for (const req of spec.required) {
      if (!present.has(req)) c.add('missing-required-property', call, `"${event}" is missing required property "${req}"`, { event, property: req });
    }
  }
}

function visit(c: Collector, plan: TrackingPlan, trackers: ReadonlySet<string>, node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const name = dottedName(node.expression);
    if (name !== null && trackers.has(name)) {
      c.calls++;
      const first = node.arguments[0];
      const event = first === undefined || ts.isSpreadElement(first) ? null : stringLiteralText(first);
      if (event === null) {
        c.add('non-literal-event-name', node, `the event name passed to ${name}() is not a string literal, so it cannot be checked against the plan`);
      } else {
        c.checked++;
        if (getEvent(plan, event) === undefined) {
          c.add('unknown-event', node, `event "${event}" is not in the plan`, { event });
        } else {
          checkProperties(c, plan, event, node);
        }
      }
    }
  }
  ts.forEachChild(node, (child) => visit(c, plan, trackers, child));
}

export function lintSource(file: string, text: string, plan: TrackingPlan, trackers: readonly string[] = DEFAULT_TRACKERS): SourceLintResult {
  const kind = SOURCE_EXTENSIONS[extname(file).toLowerCase()] ?? ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const c = new Collector(sf, file);
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  for (const d of diagnostics.slice(0, 3)) {
    c.add('parse-error', d.start, `syntax error, so calls near it may be missed: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  visit(c, plan, new Set(trackers), sf);
  c.findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  return { calls: c.calls, checked: c.checked, valuesNotChecked: c.valuesNotChecked, findings: c.findings };
}

function isSourceFile(name: string): boolean {
  return !name.endsWith('.d.ts') && !name.endsWith('.d.mts') && !name.endsWith('.d.cts') && extname(name).toLowerCase() in SOURCE_EXTENSIONS;
}

function walk(dir: string, out: Set<string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full, out);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      out.add(resolve(full));
    }
  }
}

export function collectSourceFiles(paths: readonly string[]): string[] {
  const files = new Set<string>();
  for (const p of paths) {
    let stat;
    try {
      stat = statSync(p);
    } catch (e) {
      throw new Error(`cannot read ${p}: ${(e as Error).message}`);
    }
    if (stat.isDirectory()) {
      walk(p, files);
    } else if (isSourceFile(p)) {
      files.add(resolve(p));
    } else {
      throw new Error(`${p} is not a supported source file (expected ${Object.keys(SOURCE_EXTENSIONS).join(', ')}, not .d.ts)`);
    }
  }
  return [...files];
}

function displayPath(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  const shown = rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
  return shown.split('\\').join('/');
}

export function lintPaths(
  paths: readonly string[],
  plan: TrackingPlan,
  options: { trackers: readonly string[]; cwd?: string },
): PathLintResult {
  const cwd = options.cwd ?? process.cwd();
  const files = collectSourceFiles(paths)
    .map((abs) => ({ abs, shown: displayPath(abs, cwd) }))
    .sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0));
  const result: PathLintResult = { filesScanned: files.length, callsFound: 0, callsChecked: 0, valuesNotChecked: 0, findings: [] };
  for (const f of files) {
    const r = lintSource(f.shown, readFileSync(f.abs, 'utf8'), plan, options.trackers);
    result.callsFound += r.calls;
    result.callsChecked += r.checked;
    result.valuesNotChecked += r.valuesNotChecked;
    result.findings.push(...r.findings);
  }
  if (result.callsFound === 0) {
    result.findings.push({
      type: 'no-tracker-calls',
      message: `scanned ${files.length} file${files.length === 1 ? '' : 's'} and found no call to ${options.trackers.join(' or ')}; a scan that checked nothing does not pass`,
    });
  }
  return result;
}
