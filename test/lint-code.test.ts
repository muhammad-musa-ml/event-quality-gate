import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Finding } from '../src/findings.js';
import { DEFAULT_TRACKERS, lintPaths, lintSource } from '../src/lint-code.js';
import { parsePlan } from '../src/plan.js';

const plan = parsePlan({
  version: 1,
  events: {
    signup: {
      properties: {
        method: { type: 'string', enum: ['email', 'sso'] },
        seats: { type: 'integer' },
        ratio: { type: 'number' },
        ok: { type: 'boolean' },
        note: { type: 'string' },
        tier: { type: 'string', enum: ['free', 'plus'] },
        email: { type: 'string', pii: true },
      },
      required: ['method'],
    },
    ping: {},
  },
});

function lint(code: string, trackers: readonly string[] = DEFAULT_TRACKERS, file = 'a.ts') {
  return lintSource(file, code, plan, trackers);
}

function types(findings: Finding[]): string[] {
  return findings.map((f) => f.type);
}

describe('lintSource: calls that match the plan', () => {
  it('passes clean calls in several syntaxes and counts them', () => {
    const r = lint(`
      track('signup', { method: 'email' });
      analytics.track("signup", { method: "sso", seats: 3, ratio: 0.5, ok: true });
      track('ping');
      track(\`signup\`, { 'method': 'email', note: \`plain\` });
      analytics?.track('ping', {});
      track('signup', { method: 'email' as const, seats: -1, ratio: +2.5 });
    `);
    expect(r.findings).toEqual([]);
    expect(r.calls).toBe(6);
    expect(r.checked).toBe(6);
  });

  it('finds calls nested in functions, classes and callbacks', () => {
    const r = lint(`
      class A { m() { return () => { track('signp', {}); }; } }
      function f() { [1].map(() => analytics.track('ping2')); }
    `);
    expect(types(r.findings)).toEqual(['unknown-event', 'unknown-event']);
  });
});

describe('lintSource: findings and where they point', () => {
  it('reports an unknown event at the call', () => {
    const r = lint(`const x = 1;\n  track('signp', {});`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ type: 'unknown-event', file: 'a.ts', line: 2, column: 3, event: 'signp' });
  });

  it('treats an inherited name as unknown', () => {
    expect(types(lint(`track('constructor', {});`).findings)).toEqual(['unknown-event']);
    expect(types(lint(`track('toString');`).findings)).toEqual(['unknown-event']);
  });

  it('reports a missing required property at the call', () => {
    const r = lint(`track('signup', { seats: 1 });`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ type: 'missing-required-property', property: 'method', line: 1, column: 1 });
  });

  it('reports a missing required property when the call has no properties argument', () => {
    expect(types(lint(`track('signup');`).findings)).toEqual(['missing-required-property']);
  });

  it('reports an unexpected property at the property', () => {
    const r = lint(`track('signup', {\n  method: 'email',\n  extra: 1,\n});`);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ type: 'unexpected-property', property: 'extra', line: 3, column: 3 });
  });

  it('reports a numeric key as unexpected', () => {
    expect(types(lint(`track('signup', { method: 'email', 1: 'a' });`).findings)).toEqual(['unexpected-property']);
  });

  it('reports every kind of literal type mismatch', () => {
    const cases: Array<[string, string]> = [
      [`track('signup', { method: 'email', seats: '5' });`, 'string "5"'],
      [`track('signup', { method: 'email', seats: 1.5 });`, 'non-integer number'],
      [`track('signup', { method: 'email', ok: 'true' });`, 'string "true"'],
      [`track('signup', { method: 'email', ratio: 'x' });`, 'string "x"'],
      [`track('signup', { method: 5 });`, 'number 5'],
      [`track('signup', { method: 'email', seats: null });`, 'null'],
      [`track('signup', { method: 'email', note: {} });`, 'object'],
      [`track('signup', { method: 'email', note: [1] });`, 'array'],
      [`track('signup', { method: 'email', seats: true });`, 'boolean true'],
    ];
    for (const [code, fragment] of cases) {
      const r = lint(code);
      expect(types(r.findings), code).toEqual(['type-mismatch']);
      expect(r.findings[0]?.message, code).toContain(fragment);
    }
  });

  it('accepts an integer written with a decimal point and a number given as an integer', () => {
    expect(lint(`track('signup', { method: 'email', seats: 5.0, ratio: 3 });`).findings).toEqual([]);
  });

  it('reports a value outside the enum, and does not also call it a type mismatch', () => {
    const r = lint(`track('signup', { method: 'phone' });`);
    expect(types(r.findings)).toEqual(['enum-violation']);
    expect(r.findings[0]?.message).toContain('"phone"');
  });

  it('reports each problem of one call separately', () => {
    const r = lint(`track('signup', { seats: 'x', extra: 1, tier: 'gold' });`);
    expect(types(r.findings).sort()).toEqual(['enum-violation', 'missing-required-property', 'type-mismatch', 'unexpected-property']);
  });
});

describe('lintSource: what cannot be decided is reported, never passed', () => {
  it('reports a non-literal event name as unverifiable', () => {
    for (const code of [`track(name, {});`, 'track(`s${x}`, {});', `track();`, `track(...args);`, `track(EVENTS.signup, {});`, `track('a' + 'b', {});`]) {
      const r = lint(code);
      expect(types(r.findings), code).toEqual(['non-literal-event-name']);
      expect(r.calls, code).toBe(1);
      expect(r.checked, code).toBe(0);
    }
  });

  it('reports a properties argument that is not an object literal', () => {
    for (const code of [`track('signup', props);`, `track('signup', makeProps());`, `track('signup', ...rest);`]) {
      expect(types(lint(code).findings), code).toEqual(['unverifiable-properties']);
    }
  });

  it('reports only the unknown event when the event is not in the plan and the properties are opaque', () => {
    expect(types(lint(`track('signp', props);`).findings)).toEqual(['unknown-event']);
  });

  it('reports a spread once, and still checks the explicit keys', () => {
    const r = lint(`track('signup', { ...base, extra: 1, seats: 'x' });`);
    expect(types(r.findings).sort()).toEqual(['type-mismatch', 'unexpected-property', 'unverifiable-properties']);
  });

  it('does not call a required property missing when a spread may supply it', () => {
    expect(types(lint(`track('signup', { ...base });`).findings)).toEqual(['unverifiable-properties']);
  });

  it('reports a computed key as unverifiable, and reads a computed string literal as a key', () => {
    expect(types(lint(`track('signup', { method: 'email', [k]: 1 });`).findings)).toEqual(['unverifiable-properties']);
    expect(lint(`track('signup', { ['method']: 'email' });`).findings).toEqual([]);
  });

  it('counts values it could not check instead of dropping them silently', () => {
    const r = lint(`track('signup', { method: 'email', seats: count, note: 'x', ok, tier: \`p\${n}\` });`);
    expect(r.findings).toEqual([]);
    expect(r.valuesNotChecked).toBe(3);
  });

  it('checks the type of a template literal with substitutions, but not its enum', () => {
    expect(types(lint('track(\'signup\', { method: \'email\', seats: `a${b}` });').findings)).toEqual(['type-mismatch']);
    expect(lint('track(\'signup\', { method: `e${b}` });').findings).toEqual([]);
  });

  it('treats a literal undefined as absent', () => {
    expect(types(lint(`track('signup', { method: undefined });`).findings)).toEqual(['missing-required-property']);
    expect(lint(`track('signup', { method: 'email', seats: undefined, bogus: undefined });`).findings).toEqual([]);
  });

  it('reads through casts and parentheses', () => {
    expect(types(lint(`track('signup', { method: ('phone' as string) });`).findings)).toEqual(['enum-violation']);
    expect(types(lint(`track('signup', { method: 'email', seats: ('5' as unknown as number) });`).findings)).toEqual(['type-mismatch']);
  });
});

describe('lintSource: PII-shaped literals', () => {
  it('reports an email literal in a property that is not declared pii', () => {
    const r = lint(`track('signup', { method: 'email', note: 'jane.doe@example.com' });`);
    expect(types(r.findings)).toEqual(['pii-shaped-value']);
    expect(r.findings[0]?.message).toContain('email');
  });

  it('reports a phone literal', () => {
    expect(types(lint(`track('signup', { method: 'email', note: '(555) 010-0199' });`).findings)).toEqual(['pii-shaped-value']);
  });

  it('accepts the same value in a property declared pii', () => {
    expect(lint(`track('signup', { method: 'email', email: 'jane.doe@example.com' });`).findings).toEqual([]);
  });

  it('also reports it in an undeclared property', () => {
    expect(types(lint(`track('signup', { method: 'email', contact: 'jane.doe@example.com' });`).findings).sort()).toEqual([
      'pii-shaped-value',
      'unexpected-property',
    ]);
  });
});

describe('lintSource: which calls count as tracker calls', () => {
  it('ignores calls to anything that is not a configured tracker', () => {
    const r = lint(`track2('x'); foo.track('x'); logEvent('x'); window.analytics.track('x'); analytics['track']('x'); track.bind(null)('x');`);
    expect(r.calls).toBe(0);
    expect(r.findings).toEqual([]);
  });

  it('uses the trackers it is given', () => {
    const code = `track('bad'); mixpanel.track('bad'); this.analytics.track('bad'); this.analytics?.track('bad');`;
    expect(lint(code, ['mixpanel.track']).calls).toBe(1);
    expect(lint(code, ['this.analytics.track']).calls).toBe(2);
    expect(lint(code).calls).toBe(1);
  });
});

describe('lintSource: syntax errors are not skipped quietly', () => {
  it('reports a parse error with its position', () => {
    const r = lint(`const a = 1;\ntrack('signup', {`);
    expect(r.findings.some((f) => f.type === 'parse-error' && f.line === 2)).toBe(true);
  });

  it('parses JSX in .tsx files', () => {
    const r = lint(`const B = () => <button onClick={() => track('signp')}>x</button>;`, DEFAULT_TRACKERS, 'b.tsx');
    expect(types(r.findings)).toEqual(['unknown-event']);
  });
});

describe('lintPaths', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eqg-lint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, text: string) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }

  it('walks a directory in sorted order and skips node_modules, dist, declaration files and other extensions', () => {
    write('b.ts', `track('bad1');`);
    write('a.tsx', `track('bad2');`);
    write('sub/c.js', `track('bad3');`);
    write('node_modules/x/index.js', `track('hidden');`);
    write('dist/o.js', `track('hidden');`);
    write('types.d.ts', `declare function track(n: string): void; track('hidden');`);
    write('notes.md', `track('hidden')`);
    const r = lintPaths([dir], plan, { trackers: DEFAULT_TRACKERS });
    expect(r.filesScanned).toBe(3);
    expect(r.findings.map((f) => f.event)).toEqual(['bad2', 'bad1', 'bad3']);
  });

  it('fails a scan that finds no tracker calls at all', () => {
    write('a.ts', `export const x = 1;`);
    const r = lintPaths([dir], plan, { trackers: DEFAULT_TRACKERS });
    expect(r.callsFound).toBe(0);
    expect(types(r.findings)).toEqual(['no-tracker-calls']);
  });

  it('fails a scan of a folder with no source files', () => {
    write('readme.md', 'x');
    const r = lintPaths([dir], plan, { trackers: DEFAULT_TRACKERS });
    expect(r.filesScanned).toBe(0);
    expect(types(r.findings)).toEqual(['no-tracker-calls']);
  });

  it('throws for a path that does not exist and for an explicit file of an unsupported type', () => {
    expect(() => lintPaths([join(dir, 'missing')], plan, { trackers: DEFAULT_TRACKERS })).toThrowError(/cannot read/);
    write('x.md', 'hi');
    expect(() => lintPaths([join(dir, 'x.md')], plan, { trackers: DEFAULT_TRACKERS })).toThrowError(/not a supported source file/);
  });

  it('takes files and directories together and reads each file once', () => {
    write('a.ts', `track('bad');`);
    const r = lintPaths([join(dir, 'a.ts'), dir], plan, { trackers: DEFAULT_TRACKERS });
    expect(r.filesScanned).toBe(1);
    expect(r.findings).toHaveLength(1);
  });

  it('reports paths with forward slashes relative to the working directory', () => {
    write('sub/a.ts', `track('bad');`);
    const r = lintPaths([dir], plan, { trackers: DEFAULT_TRACKERS, cwd: dir });
    expect(r.findings[0]?.file).toBe('sub/a.ts');
  });
});
