import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import type { Io } from '../src/cli.js';
import { VERSION } from '../src/version.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const plan = 'examples/tracking-plan.json';

async function run(args: string[], cwd = root): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { stdout: (s) => (out += s), stderr: (s) => (err += s), cwd };
  const code = await main(args, io);
  return { code, out, err };
}

// Paths in these tests are relative to the repository root, so the cwd of the process is not touched.
function atRoot(): void {
  process.chdir(root);
}

describe('eqg: help and version', () => {
  beforeEach(atRoot);

  it('prints usage and exits 0 for help', async () => {
    for (const flag of ['--help', '-h', 'help']) {
      const r = await run([flag]);
      expect(r.code, flag).toBe(0);
      expect(r.out).toContain('eqg lint-code');
      expect(r.out).toContain('exit codes');
    }
  });

  it('prints the package version', async () => {
    const r = await run(['--version']);
    expect(r.out.trim()).toBe(VERSION);
    expect(VERSION).toBe((JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version);
  });

  it('exits 2 with usage when there is no command or an unknown one', async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.err).toContain('usage');
    const unknown = await run(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('unknown command "frobnicate"');
  });
});

describe('eqg lint-code', () => {
  beforeEach(atRoot);

  it('passes the clean sample', async () => {
    const r = await run(['lint-code', 'examples/code/clean', '--plan', plan]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS: no findings');
    expect(r.out).toContain('9 calls');
  });

  it('fails the planted-fault sample with file:line:column findings', async () => {
    const r = await run(['lint-code', 'examples/code/faulty', '--plan', plan]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^examples\/code\/faulty\/onboarding\.ts:7:3: unknown-event: /m);
    expect(r.out.trimEnd().endsWith('FAIL')).toBe(true);
  });

  it('writes the same findings as JSON', async () => {
    const r = await run(['lint-code', 'examples/code/faulty', '--plan', plan, '--format', 'json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as { result: string; summary: { findings: number; findingsByType: Record<string, number> }; findings: Array<{ file: string; line: number }> };
    expect(j.result).toBe('fail');
    expect(j.summary.findings).toBe(8);
    expect(Object.keys(j.summary.findingsByType)).toHaveLength(8);
    expect(j.findings[0]).toMatchObject({ file: 'examples/code/faulty/onboarding.ts', line: 7 });
  });

  describe('with a scratch folder', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'eqg-cli-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('still fails on unverifiable calls unless they are allowed, and says which it allowed', async () => {
      const file = join(dir, 'a.ts');
      writeFileSync(file, `track(name, { method: 'email' });\ntrack('ping_unknown_to_nobody', {});\n`);
      writeFileSync(join(dir, 'b.ts'), `track(name2);\n`);
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({ version: 1, events: { ping: {} } }));
      const only = join(dir, 'only.ts');
      writeFileSync(only, `track(name);\ntrack('ping');\n`);
      const strict = await run(['lint-code', only, '--plan', planFile]);
      expect(strict.code).toBe(1);
      const allowed = await run(['lint-code', only, '--plan', planFile, '--allow-unverifiable']);
      expect(allowed.code).toBe(0);
      expect(allowed.out).toContain('PASS: 1 unverifiable finding allowed');
      expect(allowed.out).toContain('non-literal-event-name');
      const withReal = await run(['lint-code', file, '--plan', planFile, '--allow-unverifiable']);
      expect(withReal.code).toBe(1);
    });

    it('uses the trackers it is told to', async () => {
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({ version: 1, events: { ping: {} } }));
      const file = join(dir, 'a.ts');
      writeFileSync(file, `mixpanel.track('nope');\n`);
      expect((await run(['lint-code', file, '--plan', planFile])).code).toBe(1);
      const r = await run(['lint-code', file, '--plan', planFile, '--tracker', 'mixpanel.track']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('unknown-event');
      expect(r.out).not.toContain('no-tracker-calls');
    });

    it('fails a scan that found no tracker calls', async () => {
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({ version: 1, events: { ping: {} } }));
      writeFileSync(join(dir, 'a.ts'), `export const x = 1;\n`);
      const r = await run(['lint-code', dir, '--plan', planFile]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('no-tracker-calls');
    });

    it('exits 2 for an invalid plan and lists the problems', async () => {
      const planFile = join(dir, 'plan.json');
      writeFileSync(planFile, JSON.stringify({ version: 1, events: { a: { required: ['x'] } }, funnel: ['a', 'b'] }));
      const r = await run(['lint-code', 'examples/code/clean', '--plan', planFile]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('is invalid');
      expect(r.err).toContain('events.a.required[0]');
      expect(r.err).toContain('funnel[1]');
    });
  });

  it('exits 2 for usage and input errors', async () => {
    expect((await run(['lint-code', '--plan', plan])).code).toBe(2);
    expect((await run(['lint-code', 'no/such/folder', '--plan', plan])).code).toBe(2);
    expect((await run(['lint-code', 'examples/code/clean', '--plan', 'no/such/plan.json'])).code).toBe(2);
    expect((await run(['lint-code', 'examples/code/clean', '--plan', plan, '--format', 'xml'])).code).toBe(2);
    expect((await run(['lint-code', 'examples/code/clean', '--plan', plan, '--bogus'])).code).toBe(2);
  });
});

describe('eqg check-stream', () => {
  beforeEach(atRoot);

  it('passes the clean stream', async () => {
    const r = await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('PASS: no findings');
  });

  it('fails the faulty stream and counts each finding type', async () => {
    const r = await run(['check-stream', 'examples/streams/faulty.jsonl', '--plan', plan, '--format', 'json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as { result: string; counts: Record<string, number>; findingsTotal: number };
    expect(j.result).toBe('fail');
    expect(Object.keys(j.counts).sort()).toEqual([
      'clock-skew',
      'duplicate-event-id',
      'enum-violation',
      'funnel-out-of-order',
      'high-cardinality',
      'invalid-envelope',
      'invalid-json',
      'late-event',
      'missing-required-property',
      'pii-shaped-value',
      'type-mismatch',
      'unexpected-property',
      'unknown-event',
    ]);
    expect(j.counts['pii-shaped-value']).toBe(2);
    expect(j.findingsTotal).toBe(14);
  });

  it('keeps no examples when asked for none, and the counts stay complete', async () => {
    const r = await run(['check-stream', 'examples/streams/faulty.jsonl', '--plan', plan, '--examples', '0', '--format', 'json']);
    const j = JSON.parse(r.out) as { examples: Record<string, unknown[]>; findingsTotal: number };
    expect(Object.keys(j.examples)).toEqual([]);
    expect(j.findingsTotal).toBe(14);
  });

  it('fails an empty file, because nothing was checked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eqg-cli-'));
    try {
      const file = join(dir, 'empty.jsonl');
      writeFileSync(file, '');
      const r = await run(['check-stream', file, '--plan', plan]);
      expect(r.code).toBe(1);
      expect(r.out).toContain('no-events');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a stated tolerance', async () => {
    const strict = await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--late-tolerance', '1s']);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('late-event');
    const loose = await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--late-tolerance', '1h', '--skew-tolerance', '2h']);
    expect(loose.code).toBe(0);
  });

  it('adds timing only when asked', async () => {
    const without = JSON.parse((await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--format', 'json'])).out) as Record<string, unknown>;
    expect(without['timing']).toBeUndefined();
    const withTiming = JSON.parse((await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--format', 'json', '--timing'])).out) as { timing: { elapsedMs: number; peakRssKb: number } };
    expect(withTiming.timing.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(withTiming.timing.peakRssKb).toBeGreaterThan(1000);
  });

  it('exits 2 for usage and input errors', async () => {
    expect((await run(['check-stream', '--plan', plan])).code).toBe(2);
    expect((await run(['check-stream', 'a.jsonl', 'b.jsonl', '--plan', plan])).code).toBe(2);
    expect((await run(['check-stream', 'no/such.jsonl', '--plan', plan])).code).toBe(2);
    expect((await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--late-tolerance', 'soon'])).code).toBe(2);
    expect((await run(['check-stream', 'examples/streams/clean.jsonl', '--plan', plan, '--examples', '-1'])).code).toBe(2);
  });
});

describe('eqg readout', () => {
  beforeEach(atRoot);
  const split = 'control=1,treatment=1';

  it('passes the clean experiment and shows both intervals and CUPED', async () => {
    const r = await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--covariates', 'examples/experiment/pre-period.jsonl']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('by user (delta method, 95%)');
    expect(r.out).toContain('by request (treated as independent)');
    expect(r.out).toContain('CUPED');
    expect(r.out).toContain('the two intervals disagree about zero');
  });

  it('fails the experiment with a sample ratio mismatch', async () => {
    const r = await run(['readout', 'examples/experiment/srm.jsonl', '--split', split, '--format', 'json']);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out) as { result: string; srm: { passed: boolean; observed: number[] }; findingsByType: Record<string, number> };
    expect(j.result).toBe('fail');
    expect(j.srm.passed).toBe(false);
    expect(j.srm.observed).toEqual([240, 160]);
    expect(j.findingsByType).toEqual({ 'sample-ratio-mismatch': 1 });
  });

  it('uses the confidence level it is given', async () => {
    const narrow = JSON.parse((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--level', '0.8', '--format', 'json'])).out) as { arms: Array<{ clustered: { lower: number; upper: number } }> };
    const wide = JSON.parse((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--level', '0.99', '--format', 'json'])).out) as { arms: Array<{ clustered: { lower: number; upper: number } }> };
    const width = (a: { lower: number; upper: number }) => a.upper - a.lower;
    expect(width(narrow.arms[0]!.clustered)).toBeLessThan(width(wide.arms[0]!.clustered));
  });

  it('exits 2 for usage and input errors', async () => {
    expect((await run(['readout', 'examples/experiment/clean.jsonl'])).code).toBe(2);
    expect((await run(['readout', 'examples/experiment/clean.jsonl', '--split', 'control=1'])).code).toBe(2);
    expect((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--level', '1.5'])).code).toBe(2);
    expect((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--srm-alpha', '0'])).code).toBe(2);
    expect((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--control', 'holdout'])).code).toBe(2);
    expect((await run(['readout', 'no/such.jsonl', '--split', split])).code).toBe(2);
    expect((await run(['readout', 'examples/experiment/clean.jsonl', '--split', split, '--covariates', 'no/such.jsonl'])).code).toBe(2);
  });
});

describe('eqg validate-plan', () => {
  beforeEach(atRoot);

  it('accepts the example plan', async () => {
    const r = await run(['validate-plan', plan]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('5 events');
  });

  it('exits 1 and lists every problem for an invalid plan, and 2 when the file cannot be read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eqg-cli-'));
    try {
      const file = join(dir, 'bad.json');
      writeFileSync(file, JSON.stringify({ version: 2, events: {} }));
      const r = await run(['validate-plan', file]);
      expect(r.code).toBe(1);
      expect(r.err).toContain('version: must be 1');
      expect(r.err).toContain('events: must declare at least one event');
      writeFileSync(file, '{not json');
      expect((await run(['validate-plan', file])).code).toBe(2);
      expect((await run(['validate-plan', join(dir, 'missing.json')])).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the built binary', () => {
  const outDir = join(root, 'tmp', 'cli-test-build');
  const cli = join(outDir, 'src', 'cli.js');

  beforeAll(() => {
    execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', 'tsconfig.json', '--outDir', outDir], { cwd: root });
  }, 120_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  function exec(args: string[], input?: string) {
    const options = input === undefined ? { cwd: root, encoding: 'utf8' as const } : { cwd: root, encoding: 'utf8' as const, input };
    return spawnSync(process.execPath, [cli, ...args], options);
  }

  it('exits 0 on the clean sample and 1 on the planted-fault sample', () => {
    expect(exec(['lint-code', 'examples/code/clean', '--plan', plan]).status).toBe(0);
    const bad = exec(['lint-code', 'examples/code/faulty', '--plan', plan]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('unknown-event');
  });

  it('exits 2 on a missing plan', () => {
    const r = exec(['lint-code', 'examples/code/clean', '--plan', 'missing.json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read tracking plan');
  });

  it('reads a stream from standard input', () => {
    const clean = readFileSync(join(root, 'examples', 'streams', 'clean.jsonl'), 'utf8');
    const ok = exec(['check-stream', '-', '--plan', plan], clean);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('222 events');
    const empty = exec(['check-stream', '-', '--plan', plan], '');
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain('no-events');
  });

  it('runs the readout and exits 1 on a sample ratio mismatch', () => {
    expect(exec(['readout', 'examples/experiment/srm.jsonl', '--split', 'control=1,treatment=1']).status).toBe(1);
    expect(exec(['readout', 'examples/experiment/clean.jsonl', '--split', 'control=1,treatment=1']).status).toBe(0);
  });
});
