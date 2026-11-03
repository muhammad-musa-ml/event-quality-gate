import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReadoutAccumulator, parseSplit, readCovariates, runReadout } from '../src/readout.js';
import type { ReadoutOptions, ReadoutReport } from '../src/readout.js';

const base: ReadoutOptions = { split: { control: 1, treatment: 1 }, control: 'control', level: 0.95, srmAlpha: 0.001 };

function report(rows: Array<[string, string, number, number?]>, options: Partial<ReadoutOptions> = {}): ReadoutReport {
  const acc = new ReadoutAccumulator({ ...base, ...options });
  for (const [userId, arm, y, x] of rows) acc.add({ userId, arm, y, x: x ?? 1 });
  return acc.finish();
}

/** Users with per-user (successes, requests) as binary request rows. */
function binaryRows(arm: string, prefix: string, users: Array<[number, number]>): Array<[string, string, number, number?]> {
  const rows: Array<[string, string, number, number?]> = [];
  users.forEach(([successes, requests], i) => {
    for (let r = 0; r < requests; r++) rows.push([`${prefix}${i}`, arm, r < successes ? 1 : 0]);
  });
  return rows;
}

const types = (r: ReadoutReport) => r.findings.map((f) => f.type);

describe('parseSplit', () => {
  it('reads arm=weight pairs in order', () => {
    expect(parseSplit('control=0.5,treatment=0.5')).toEqual({ control: 0.5, treatment: 0.5 });
    expect(Object.keys(parseSplit('a=1, b=1 ,c=2'))).toEqual(['a', 'b', 'c']);
  });
  it('refuses malformed input', () => {
    for (const bad of ['', 'control', 'control=0.5', 'a=1,a=1', 'a=x,b=1', 'a=0,b=1', 'a=-1,b=1', '=1,b=1', 'a=1,b=']) {
      expect(() => parseSplit(bad), bad).toThrowError(/split/);
    }
  });
});

describe('ReadoutAccumulator: hand-computed data', () => {
  // control: 4 users, (successes, requests) = (2,2) (0,2) (2,2) (0,2). Per user y = [2,0,2,0], x = [2,2,2,2]:
  //   R = 0.5, user-level Var = 1/12, request-level Var (8 binary rows) = 1/28.
  // treatment: 4 users, (1,2) (2,4) (1,3) (2,3). Per user y = [1,2,1,2], x = [2,4,3,3]:
  //   R = 0.5, user-level Var = 1/216, request-level Var (12 binary rows, 6 successes) = (1/12)(3/11) = 1/44.
  // The difference is 0. User-level Var = 1/12 + 1/216 = 19/216; request-level Var = 1/28 + 1/44 = 9/154.
  const rows = [
    ...binaryRows('control', 'c', [[2, 2], [0, 2], [2, 2], [0, 2]]),
    ...binaryRows('treatment', 't', [[1, 2], [2, 4], [1, 3], [2, 3]]),
  ];
  const r = report(rows);

  it('has no findings and counts users and rows', () => {
    expect(r.findings).toEqual([]);
    expect(r.rows).toBe(20);
    expect(r.users).toBe(8);
    expect(r.arms.map((a) => [a.arm, a.users, a.requests])).toEqual([
      ['control', 4, 8],
      ['treatment', 4, 12],
    ]);
  });

  it('gets the clustered and the request-level variances of each arm', () => {
    const [c, t] = r.arms;
    expect(c!.clustered!.ratio).toBeCloseTo(0.5, 12);
    expect(c!.clustered!.variance).toBeCloseTo(1 / 12, 12);
    expect(c!.naive!.variance).toBeCloseTo(1 / 28, 12);
    expect(t!.clustered!.variance).toBeCloseTo(1 / 216, 12);
    expect(t!.naive!.variance).toBeCloseTo(1 / 44, 12);
    expect(c!.clustered!.n).toBe(4);
    expect(c!.naive!.n).toBe(8);
  });

  it('compares each arm with the control the same two ways', () => {
    expect(r.comparisons).toHaveLength(1);
    const cmp = r.comparisons[0]!;
    expect(cmp.arm).toBe('treatment');
    expect(cmp.clustered.diff).toBeCloseTo(0, 12);
    expect(cmp.clustered.variance).toBeCloseTo(19 / 216, 12);
    expect(cmp.naive.variance).toBeCloseTo(9 / 154, 12);
    expect(cmp.intervalWidthRatio).toBeCloseTo(Math.sqrt(19 / 216 / (9 / 154)), 12);
  });

  it('passes the sample ratio test at 4 against 4', () => {
    expect(r.srm!.observed).toEqual([4, 4]);
    expect(r.srm!.chi2).toBeCloseTo(0, 12);
    expect(r.srm!.p).toBe(1);
    expect(r.srm!.passed).toBe(true);
  });
});

describe('ReadoutAccumulator: what it refuses to pass', () => {
  it('fails an empty input', () => {
    expect(types(report([]))).toEqual(['no-events']);
  });

  it('fails a sample ratio mismatch and names the counts', () => {
    // 600 vs 400 users on a 50/50 plan: expected 500 each, chi2 = 2 * 100^2 / 500 = 40, df = 1, p ~ 2.5e-10.
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 600; i++) rows.push([`c${i}`, 'control', i % 2]);
    for (let i = 0; i < 400; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    const r = report(rows);
    expect(r.srm!.chi2).toBeCloseTo(40, 10);
    expect(r.srm!.p).toBeLessThan(1e-9);
    expect(r.srm!.passed).toBe(false);
    expect(types(r)).toEqual(['sample-ratio-mismatch']);
    expect(r.findings[0]?.message).toContain('600');
    expect(r.findings[0]?.message).toContain('400');
  });

  it('applies the alpha it is given, and passes at the boundary side', () => {
    // 60 vs 40: chi2 = 4, p = 0.0455. Fails at alpha 0.05, passes at the default 0.001.
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 60; i++) rows.push([`c${i}`, 'control', i % 2]);
    for (let i = 0; i < 40; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    expect(types(report(rows))).toEqual([]);
    expect(types(report(rows, { srmAlpha: 0.05 }))).toEqual(['sample-ratio-mismatch']);
  });

  it('uses the planned split, not an even one', () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 900; i++) rows.push([`c${i}`, 'control', i % 2]);
    for (let i = 0; i < 100; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    expect(types(report(rows, { split: { control: 9, treatment: 1 } }))).toEqual([]);
    expect(types(report(rows))).toEqual(['sample-ratio-mismatch']);
  });

  it('excludes a user who appears in two arms and says so', () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 5; i++) rows.push([`c${i}`, 'control', i % 2]);
    for (let i = 0; i < 5; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    rows.push(['c0', 'treatment', 1]);
    const r = report(rows);
    expect(types(r)).toContain('user-in-multiple-arms');
    expect(r.usersInMultipleArms).toBe(1);
    expect(r.users).toBe(9);
    expect(r.srm!.observed).toEqual([4, 5]);
  });

  it('fails an arm that is not in the plan and does not analyse its rows', () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 5; i++) rows.push([`c${i}`, 'control', i % 2]);
    for (let i = 0; i < 5; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    rows.push(['x1', 'holdout', 1], ['x2', 'holdout', 0]);
    const r = report(rows);
    expect(types(r)).toEqual(['unplanned-arm']);
    expect(r.rowsIgnored).toBe(2);
    expect(r.users).toBe(10);
  });

  it('fails an arm with fewer than two users and gives no interval for it', () => {
    const rows: Array<[string, string, number]> = [['c0', 'control', 1], ['c1', 'control', 0], ['c2', 'control', 1], ['t0', 'treatment', 1]];
    const r = report(rows, { srmAlpha: 1e-12 });
    expect(types(r)).toEqual(['too-few-users']);
    expect(r.arms.find((a) => a.arm === 'treatment')?.clustered).toBeNull();
    expect(r.comparisons).toEqual([]);
  });

  it('fails an arm whose denominator is zero', () => {
    const rows: Array<[string, string, number, number]> = [];
    for (let i = 0; i < 4; i++) rows.push([`c${i}`, 'control', 1, 1]);
    for (let i = 0; i < 4; i++) rows.push([`t${i}`, 'treatment', 0, 0]);
    const r = report(rows);
    expect(types(r)).toEqual(['zero-denominator']);
    expect(r.comparisons).toEqual([]);
  });

  it('fails when the planned control arm has no users, and has no comparison to make', () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 5; i++) rows.push([`t${i}`, 'treatment', i % 2]);
    const r = report(rows);
    expect(types(r)).toEqual(['too-few-users']);
    expect(r.findings[0]?.message).toContain('"control"');
    expect(r.comparisons).toEqual([]);
  });
});

describe('ReadoutAccumulator: clustered against request-level intervals', () => {
  it('are identical when every user has exactly one request', () => {
    const rows: Array<[string, string, number]> = [];
    for (let i = 0; i < 30; i++) rows.push([`c${i}`, 'control', (i * 7) % 5]);
    for (let i = 0; i < 30; i++) rows.push([`t${i}`, 'treatment', (i * 3) % 4]);
    const r = report(rows);
    for (const a of r.arms) {
      expect(a.clustered!.ratio).toBeCloseTo(a.naive!.ratio, 12);
      expect(a.clustered!.variance).toBeCloseTo(a.naive!.variance, 12);
    }
    expect(r.comparisons[0]!.intervalWidthRatio).toBeCloseTo(1, 12);
  });

  it('flags the case where the request-level interval excludes zero and the user-level one does not', () => {
    // 20 users per arm with 10 requests each, every user all-success or all-failure.
    // control: 10 of 20 users succeed (R = 0.5); treatment: 12 of 20 users succeed (R = 0.6).
    // Request-level (200 rows per arm): Var = 0.2513/200 + 0.2412/200 = 0.002462, se 0.0496, interval 0.1 +- 0.0972: excludes 0.
    // User-level: s2_y = 26.32 and 25.26 on y_u in {0, 10}, Var = s2/(20 * 100) = 0.01316 + 0.01263 = 0.02579,
    //   se 0.1606, interval 0.1 +- 0.3148: includes 0.
    const make = (arm: string, prefix: string, successes: number) =>
      Array.from({ length: 20 }, (_, u) => binaryRows(arm, `${prefix}${u}`, [[u < successes ? 10 : 0, 10]])).flat();
    const r = report([...make('control', 'c', 10), ...make('treatment', 't', 12)]);
    const cmp = r.comparisons[0]!;
    expect(cmp.clustered.diff).toBeCloseTo(0.1, 12);
    expect(cmp.naiveExcludesZero).toBe(true);
    expect(cmp.clusteredExcludesZero).toBe(false);
    expect(cmp.naive.lower).toBeGreaterThan(0);
    expect(cmp.clustered.lower).toBeLessThan(0);
    expect(cmp.clustered.upper).toBeGreaterThan(0);
    expect(cmp.intervalWidthRatio).toBeCloseTo(Math.sqrt(0.02579 / 0.002462), 1);
  });
});

describe('ReadoutAccumulator: CUPED', () => {
  // Covariate c = [1, 2, 3, 4] in both arms; control y = [3, 3, 5, 9]; treatment y = [3, 7, 9, 9]. theta = 2; see stats.test.ts.
  const rows: Array<[string, string, number]> = [
    ...[3, 3, 5, 9].map((y, i): [string, string, number] => [`c${i}`, 'control', y]),
    ...[3, 7, 9, 9].map((y, i): [string, string, number] => [`t${i}`, 'treatment', y]),
  ];
  const covariates = new Map<string, number>();
  [1, 2, 3, 4].forEach((c, i) => {
    covariates.set(`c${i}`, c);
    covariates.set(`t${i}`, c);
  });

  it('adjusts per-user totals and reports theta and the variance ratio', () => {
    const r = report(rows, { covariates });
    expect(r.cuped).not.toBeNull();
    expect(r.cuped!.theta).toBeCloseTo(2, 12);
    expect(r.cuped!.comparisons[0]!.varianceRatio).toBeCloseTo(1 / 6, 12);
    expect(r.cuped!.usersWithCovariate).toBe(8);
    expect(r.cuped!.usersImputed).toBe(0);
  });

  it('gives a user with no pre-period value the mean covariate, and counts them', () => {
    const missing = new Map(covariates);
    missing.delete('t3');
    const r = report(rows, { covariates: missing });
    expect(r.cuped!.usersWithCovariate).toBe(7);
    expect(r.cuped!.usersImputed).toBe(1);
  });

  it('sums a user\'s requests into one outcome', () => {
    const split: Array<[string, string, number]> = [];
    rows.forEach(([u, a, y]) => split.push([u, a, y - 1], [u, a, 1]));
    const r = report(split, { covariates });
    expect(r.cuped!.theta).toBeCloseTo(2, 12);
  });

  it('is null when no covariates are given', () => {
    expect(report(rows).cuped).toBeNull();
  });

  it('refuses a covariate file that matches none of the users', () => {
    expect(() => report(rows, { covariates: new Map([['nobody', 1]]) })).toThrowError(/matches none of the users/);
  });
});

describe('reading files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eqg-readout-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs end to end on a JSONL file, with a default x of 1, blank lines and a byte order mark', async () => {
    const file = join(dir, 'rows.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) lines.push(JSON.stringify({ user_id: `c${i}`, arm: 'control', y: i % 2 }));
    lines.push('');
    for (let i = 0; i < 6; i++) lines.push(JSON.stringify({ user_id: `t${i}`, arm: 'treatment', y: 1, x: 1 }));
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(file, `${bom}${lines.join('\r\n')}\r\n`);
    const r = await runReadout(file, base);
    expect(r.rows).toBe(12);
    expect(r.users).toBe(12);
    expect(r.findings).toEqual([]);
  });

  it('names the line of a malformed row and does not guess', async () => {
    const bad: Array<[string, RegExp]> = [
      ['{oops', /:2: not valid JSON/],
      ['[]', /:2: .*object/],
      [JSON.stringify({ arm: 'a', y: 1 }), /:2: user_id/],
      [JSON.stringify({ user_id: 'u', y: 1 }), /:2: arm/],
      [JSON.stringify({ user_id: 'u', arm: 'a' }), /:2: y must be a finite number/],
      [JSON.stringify({ user_id: 'u', arm: 'a', y: '1' }), /:2: y must be a finite number/],
      [JSON.stringify({ user_id: 'u', arm: 'a', y: 1, x: 'z' }), /:2: x must be a finite number/],
      [JSON.stringify({ user_id: 'u', arm: 'a', y: 1, x: null }), /:2: x must be a finite number/],
    ];
    for (const [line, pattern] of bad) {
      const file = join(dir, 'bad.jsonl');
      writeFileSync(file, `${JSON.stringify({ user_id: 'u0', arm: 'control', y: 1 })}\n${line}\n`);
      await expect(runReadout(file, base), line).rejects.toThrowError(pattern);
    }
  });

  it('reports a missing file', async () => {
    await expect(runReadout(join(dir, 'nope.jsonl'), base)).rejects.toThrowError(/cannot read/);
  });

  it('reads a covariates file', async () => {
    const file = join(dir, 'pre.jsonl');
    writeFileSync(file, `${JSON.stringify({ user_id: 'a', pre: 3 })}\n\n${JSON.stringify({ user_id: 'b', pre: 4.5 })}\n`);
    expect([...(await readCovariates(file)).entries()]).toEqual([
      ['a', 3],
      ['b', 4.5],
    ]);
  });

  it('refuses a malformed covariates file, a repeated user and an empty one', async () => {
    const file = join(dir, 'pre.jsonl');
    writeFileSync(file, `${JSON.stringify({ user_id: 'a', pre: 'x' })}\n`);
    await expect(readCovariates(file)).rejects.toThrowError(/:1: pre must be a finite number/);
    writeFileSync(file, `${JSON.stringify({ user_id: 'a', pre: 1 })}\n${JSON.stringify({ user_id: 'a', pre: 2 })}\n`);
    await expect(readCovariates(file)).rejects.toThrowError(/:2: user "a" appears twice/);
    writeFileSync(file, '');
    await expect(readCovariates(file)).rejects.toThrowError(/no covariates/);
  });
});
