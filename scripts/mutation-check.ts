// Puts one defect at a time into a COPY of the code (never into the working tree) and runs the tests against it.
// A mutant is killed when the tests fail. Each mutant is first run against the test files closest to it; if those
// pass, the whole suite is run before the mutant is called a survivor.
//   node dist/scripts/mutation-check.js
// Refuses to run when tracked files have uncommitted changes, so the copy is always of a known commit.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMeta, writeJson } from './meta.js';
import { isMain, repoRoot } from './paths.js';

interface Mutant {
  id: string;
  file: string;
  /** Text that occurs exactly once in the file. */
  find: string;
  replace: string;
  /** What the defect is, in words. */
  defect: string;
  tests: string[];
}

const LINT = ['test/lint-code.test.ts'];
const STREAM = ['test/check-stream.test.ts'];
const STATS = ['test/stats.test.ts'];
const READOUT = ['test/readout.test.ts'];
const PLAN = ['test/plan.test.ts'];
const PII = ['test/pii.test.ts'];
const CLI = ['test/cli.test.ts'];

export const MUTANTS: Mutant[] = [
  { id: 'L1', file: 'src/lint-code.ts', find: 'return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;', replace: 'return ts.isStringLiteral(x) ? x.text : null;', defect: 'a backtick string with no substitution is no longer read as a literal event name', tests: LINT },
  { id: 'L2', file: 'src/lint-code.ts', find: '    ts.isAsExpression(cur) ||\n', replace: '', defect: 'a value wrapped in `as` is no longer read through', tests: LINT },
  { id: 'L3', file: 'src/lint-code.ts', find: '  if (!opaque) {\n    for (const req of spec.required) {', replace: '  if (true) {\n    for (const req of spec.required) {', defect: 'required properties are reported missing even when a spread may supply them', tests: LINT },
  { id: 'L4', file: 'src/lint-code.ts', find: "if (lit.kind !== 'undefined') present.add(key);", replace: 'present.add(key);', defect: 'a property set to undefined counts as present', tests: LINT },
  { id: 'L5', file: 'src/lint-code.ts', find: 'if (spec.enum && !spec.enum.includes(', replace: 'if (spec.enum && spec.enum.includes(', defect: 'the enum test is inverted', tests: LINT },
  { id: 'L6', file: 'src/lint-code.ts', find: "lit.type === 'string' && spec?.pii !== true", replace: "lit.type === 'string'", defect: 'PII-shaped literals are reported even where the plan declares pii', tests: LINT },
  { id: 'L7', file: 'src/lint-code.ts', find: 'if (getEvent(plan, event) === undefined) {', replace: 'if (plan.events[event] === undefined) {', defect: 'event names are looked up with inherited keys (constructor, toString)', tests: LINT },
  { id: 'L8', file: 'src/lint-code.ts', find: 'if (event === null) {', replace: 'if (false) {', defect: 'a non-literal event name is silently passed', tests: LINT },
  { id: 'L9', file: 'src/lint-code.ts', find: 'if (result.callsFound === 0) {', replace: 'if (false) {', defect: 'a scan that found no tracker calls passes', tests: LINT },
  { id: 'L10', file: 'src/lint-code.ts', find: 'diagnostics.slice(0, 3)', replace: 'diagnostics.slice(0, 0)', defect: 'syntax errors are not reported', tests: LINT },
  { id: 'L11', file: 'src/lint-code.ts', find: "if (x.kind === ts.SyntaxKind.ThisKeyword) return 'this';", replace: "if (false) return 'this';", defect: 'this.analytics.track is never matched', tests: LINT },
  { id: 'L12', file: 'src/lint-code.ts', find: 'if (!matchesType(spec.type, lit.value) || lit.type === ', replace: 'if (lit.type === ', defect: 'literal type mismatches are not reported', tests: LINT },
  { id: 'A1', file: 'src/plan.ts', find: "m < 1) {\n      issues.push(`${path}.maxDistinct: must be a positive integer`);", replace: "m < 0) {\n      issues.push(`${path}.maxDistinct: must be a positive integer`);", defect: 'maxDistinct of zero is accepted', tests: PLAN },
  { id: 'A2', file: 'src/plan.ts', find: 'return Object.hasOwn(plan.events, name) ? plan.events[name] : undefined;', replace: 'return plan.events[name];', defect: 'inherited names count as declared events', tests: PLAN },
  { id: 'A3', file: 'src/plan.ts', find: 'if (rawFunnel.length < 2)', replace: 'if (rawFunnel.length < 1)', defect: 'a one-step funnel is accepted', tests: PLAN },
  { id: 'A4', file: 'src/plan.ts', find: '} else if (seen.has(value)) {', replace: '} else if (false) {', defect: 'duplicate enum values are accepted', tests: PLAN },
  { id: 'A5', file: 'src/plan.ts', find: "return typeof value === 'number' && Number.isInteger(value);", replace: "return typeof value === 'number';", defect: 'a fractional number matches the integer type', tests: PLAN.concat(STREAM, LINT) },
  { id: 'S1', file: 'src/check-stream.ts', find: 'if (delta > this.options.lateToleranceMs) {', replace: 'if (delta >= this.options.lateToleranceMs) {', defect: 'an event exactly at the lateness tolerance is called late', tests: STREAM },
  { id: 'S2', file: 'src/check-stream.ts', find: '} else if (-delta > this.options.skewToleranceMs) {', replace: '} else if (-delta >= this.options.skewToleranceMs) {', defect: 'a clock exactly at the skew tolerance is called skewed', tests: STREAM },
  { id: 'S3', file: 'src/check-stream.ts', find: 'tj < ti) {', replace: 'tj <= ti) {', defect: 'equal funnel timestamps are called out of order', tests: STREAM },
  { id: 'S4', file: 'src/check-stream.ts', find: 'if (this.seen.has(id)) {', replace: 'if (false) {', defect: 'duplicate event ids are not found', tests: STREAM },
  { id: 'S5', file: 'src/check-stream.ts', find: 'if (entry.values.size > ps.maxDistinct) {', replace: 'if (entry.values.size >= ps.maxDistinct) {', defect: 'the distinct-value bound is off by one', tests: STREAM },
  { id: 'S6', file: 'src/check-stream.ts', find: 'if (this.events === 0) {', replace: 'if (false) {', defect: 'a stream with no events passes', tests: STREAM },
  { id: 'S7', file: 'src/check-stream.ts', find: "typeof value === 'string' && ps?.pii !== true", replace: "typeof value === 'string'", defect: 'PII-shaped values are reported even where the plan declares pii', tests: STREAM },
  { id: 'S8', file: 'src/check-stream.ts', find: 'if (!Object.hasOwn(props, req))', replace: 'if (!props[req])', defect: 'a required property with a false or zero value counts as missing', tests: STREAM },
  { id: 'S9', file: 'src/check-stream.ts', find: '(?:Z|[+-]\\d{2}:\\d{2})$/', replace: '(?:Z|[+-]\\d{2}:\\d{2})?$/', defect: 'an ISO timestamp without an offset is accepted', tests: STREAM },
  { id: 'S10', file: 'src/check-stream.ts', find: 'raw.charCodeAt(0) === 0xfeff', replace: 'false', defect: 'a byte order mark is not removed', tests: STREAM },
  { id: 'S11', file: 'src/check-stream.ts', find: 'd: 86_400_000', replace: 'd: 86_400', defect: 'a day is 86.4 seconds', tests: STREAM },
  { id: 'S12', file: 'src/check-stream.ts', find: 'if (text.length > MAX_LINE_CHARS) {', replace: 'if (false) {', defect: 'the line length limit is not applied', tests: STREAM },
  { id: 'S13', file: 'src/check-stream.ts', find: 'this.missingReceivedAt++;', replace: '', defect: 'events without received_at are not counted as unchecked', tests: STREAM },
  { id: 'T1', file: 'src/stats.ts', find: '(m.varY() - 2 * ratio * m.covXY()', replace: '(m.varY() + 2 * ratio * m.covXY()', defect: 'the covariance term of the delta method has the wrong sign', tests: STATS },
  { id: 'T2', file: 'src/stats.ts', find: 'ratio * ratio * m.varX()', replace: 'ratio * m.varX()', defect: 'the ratio is not squared in the delta method', tests: STATS },
  { id: 'T3', file: 'src/stats.ts', find: '(m.n * m.meanX * m.meanX)', replace: '(m.n * m.meanX)', defect: 'the delta method divides by the mean of the denominator, not its square', tests: STATS },
  { id: 'T4', file: 'src/stats.ts', find: 'return this.m2X / (this.n - 1);', replace: 'return this.m2X / this.n;', defect: 'the variance of the denominator uses n instead of n - 1', tests: STATS },
  { id: 'T5', file: 'src/stats.ts', find: 'const df = observed.length - 1;', replace: 'const df = observed.length;', defect: 'the chi-square test has one degree of freedom too many', tests: STATS },
  { id: 'T6', file: 'src/stats.ts', find: 'chi2 += (o - e) ** 2 / e;', replace: 'chi2 += (o - e) ** 2;', defect: 'the chi-square statistic is not divided by the expected count', tests: STATS },
  { id: 'T7', file: 'src/stats.ts', find: 'const variance = treatment.variance + control.variance;', replace: 'const variance = treatment.variance;', defect: 'the control arm adds no variance to the difference', tests: STATS },
  { id: 'T8', file: 'src/stats.ts', find: 'const theta = sxx === 0 ? 0 : sxy / sxx;', replace: 'const theta = sxx === 0 ? 0 : sxy / (2 * sxx);', defect: 'the CUPED slope is halved', tests: STATS },
  { id: 'T9', file: 'src/stats.ts', find: '    x = -(((((C[0]!', replace: '    x = (((((C[0]!', defect: 'the upper tail of the normal quantile has the wrong sign', tests: STATS },
  { id: 'T10', file: 'src/stats.ts', find: 'const w = (this.n * other.n) / n;', replace: 'const w = (this.n * other.n) / this.n;', defect: 'merging two sets of moments weighs them wrongly', tests: STATS },
  { id: 'T11', file: 'src/stats.ts', find: 'return 1 - sum * front;', replace: 'return sum * front;', defect: 'the series branch of the incomplete gamma function returns the wrong tail', tests: STATS },
  { id: 'T12', file: 'src/stats.ts', find: 'if (m.n < 2) throw new RangeError', replace: 'if (m.n < 1) throw new RangeError', defect: 'an interval is computed from a single unit', tests: STATS },
  { id: 'R1', file: 'src/readout.ts', find: 'rec.conflict = true;', replace: 'rec.conflict = false;', defect: 'a user in two arms is not noticed', tests: READOUT },
  { id: 'R2', file: 'src/readout.ts', find: 'const passed = srm.p >= srmAlpha;', replace: 'const passed = srm.p <= srmAlpha;', defect: 'the sample ratio verdict is inverted', tests: READOUT },
  { id: 'R3', file: 'src/readout.ts', find: 'if (list.length < 2) {', replace: 'if (list.length < 1) {', defect: 'an arm with one user gets an interval', tests: READOUT },
  { id: 'R4', file: 'src/readout.ts', find: "obj['x'] === undefined ? 1 :", replace: "obj['x'] === undefined ? 0 :", defect: 'a row without x counts as zero requests', tests: READOUT },
  { id: 'R5', file: 'src/readout.ts', find: 'clusteredExcludesZero: clustered.lower > 0 || clustered.upper < 0', replace: 'clusteredExcludesZero: clustered.lower > 0 && clustered.upper < 0', defect: 'an interval that excludes zero is never reported as such', tests: READOUT },
  { id: 'R6', file: 'src/readout.ts', find: 'if (!Object.hasOwn(this.options.split, row.arm)) {', replace: 'if (false) {', defect: 'rows of an arm that is not in the plan are analysed', tests: READOUT },
  { id: 'R7', file: 'src/readout.ts', find: 'intervalWidthRatio: clustered.se / naive.se', replace: 'intervalWidthRatio: naive.se / clustered.se', defect: 'the width ratio is upside down', tests: READOUT },
  { id: 'R8', file: 'src/readout.ts', find: 'byRow.merge(rec.rows);', replace: 'byRow.push(rec.sumY, rec.sumX);', defect: 'the request-level interval is built from user totals', tests: READOUT },
  { id: 'P1', file: 'src/pii.ts', find: 'const PHONE_NANP = /(?<![\\d.])', replace: 'const PHONE_NANP = /', defect: 'a phone shape is matched inside a longer digit run', tests: PII },
  { id: 'P2', file: 'src/pii.ts', find: 'if (EMAIL.test(value)) return', replace: 'if (value.includes(\'@\')) return', defect: 'any text containing @ is called an email', tests: PII },
  { id: 'C1', file: 'src/cli.ts', find: 'const failed = failsGate(result.findings, allow);', replace: 'const failed = false;', defect: 'lint-code exits 0 whatever it finds', tests: CLI },
  { id: 'C2', file: 'src/cli.ts', find: 'case undefined:\n        io.stderr(USAGE);\n        return 2;', replace: 'case undefined:\n        io.stderr(USAGE);\n        return 0;', defect: 'running eqg with no command exits 0', tests: CLI },
  { id: 'C3', file: 'src/cli.ts', find: 'const failed = report.findingsTotal > 0;', replace: 'const failed = report.findingsTotal > 1;', defect: 'check-stream passes a stream with exactly one finding', tests: CLI },
  { id: 'C4', file: 'src/cli.ts', find: "io.stderr(`${e.message}\\n`);\n      return 1;", replace: "io.stderr(`${e.message}\\n`);\n      return 0;", defect: 'validate-plan exits 0 for an invalid plan', tests: CLI },
];

interface Outcome {
  id: string;
  file: string;
  defect: string;
  status: 'killed by nearby tests' | 'killed by the full suite' | 'SURVIVED' | 'NOT RUN';
  detail: string;
}

function vitest(scratch: string, files: string[]): { code: number; tail: string } {
  const args = [join(scratch, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--bail=1', ...files];
  const r = spawnSync(process.execPath, args, { cwd: scratch, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 2 ** 20 });
  const text = `${r.stdout}\n${r.stderr}`;
  const failed = /FAIL\s+(.+)/.exec(text);
  return { code: r.status ?? 2, tail: failed ? (failed[1] ?? '').trim().slice(0, 160) : '' };
}

function main(): number {
  const root = repoRoot();
  const meta = runMeta(root);
  if (meta.dirty) {
    console.log('tracked files have uncommitted changes; commit them first so the copy is of a known commit');
    return 2;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'eqg-mutation-'));
  console.log(`copy of ${meta.commit.slice(0, 7)} in ${scratch}`);
  try {
    for (const entry of ['src', 'scripts', 'test', 'examples', 'schema', 'results', 'package.json', 'tsconfig.json', 'vitest.config.ts', 'README.md']) {
      if (existsSync(join(root, entry))) cpSync(join(root, entry), join(scratch, entry), { recursive: true });
    }
    symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'junction');
    const baseline = vitest(scratch, []);
    if (baseline.code !== 0) {
      console.log(`the unmutated copy fails its own tests (${baseline.tail}); nothing to compare against`);
      return 2;
    }
    console.log('baseline: the whole suite passes on the unmutated copy');
    const outcomes: Outcome[] = [];
    for (const m of MUTANTS) {
      const path = join(scratch, m.file);
      const original = readFileSync(path, 'utf8');
      const count = original.split(m.find).length - 1;
      if (count !== 1) {
        outcomes.push({ id: m.id, file: m.file, defect: m.defect, status: 'NOT RUN', detail: `the text to change occurs ${count} times, not once` });
        console.log(`${m.id}: NOT RUN (anchor occurs ${count} times)`);
        continue;
      }
      writeFileSync(path, original.replace(m.find, () => m.replace), 'utf8');
      try {
        const near = vitest(scratch, m.tests);
        if (near.code !== 0) {
          outcomes.push({ id: m.id, file: m.file, defect: m.defect, status: 'killed by nearby tests', detail: near.tail });
        } else {
          const full = vitest(scratch, []);
          outcomes.push(
            full.code !== 0
              ? { id: m.id, file: m.file, defect: m.defect, status: 'killed by the full suite', detail: full.tail }
              : { id: m.id, file: m.file, defect: m.defect, status: 'SURVIVED', detail: 'the whole suite passed' },
          );
        }
      } finally {
        writeFileSync(path, original, 'utf8');
      }
      console.log(`${m.id}: ${outcomes[outcomes.length - 1]!.status}`);
    }
    const killed = outcomes.filter((o) => o.status.startsWith('killed')).length;
    const survived = outcomes.filter((o) => o.status === 'SURVIVED').length;
    const notRun = outcomes.filter((o) => o.status === 'NOT RUN').length;
    writeJson(join(root, 'results', 'mutation-check.json'), {
      description: 'One defect at a time put into a copy of the code; the tests are run against the copy. Killed means the tests failed.',
      command: 'node dist/scripts/mutation-check.js',
      mutants: outcomes.length,
      killed,
      survived,
      notRun,
      outcomes,
      meta,
    });
    console.log(`${killed} of ${outcomes.length} mutants killed, ${survived} survived, ${notRun} not run`);
    return survived + notRun === 0 ? 0 : 1;
  } finally {
    // The junction goes first and on its own, so removing the copy cannot reach the real node_modules.
    try {
      rmdirSync(join(scratch, 'node_modules'));
    } catch {
      /* already gone */
    }
    rmSync(scratch, { recursive: true, force: true });
    if (!existsSync(join(root, 'node_modules', 'vitest'))) console.log('WARNING: node_modules/vitest is missing from the repository folder; run npm ci');
  }
}

if (isMain(import.meta.url)) process.exitCode = main();
