import { accessSync, constants, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Finding } from './findings.js';
import { Moments2, cuped, ratioDifference, ratioInterval, srmTest } from './stats.js';
import type { CupedComparison, Difference, RatioInterval } from './stats.js';

export interface ReadoutRow {
  userId: string;
  arm: string;
  /** Numerator of the ratio metric for this request (or any additive per-row outcome). */
  y: number;
  /** Denominator for this request; 1 when the row is a single request. */
  x: number;
}

export interface ReadoutOptions {
  /** Planned share of users per arm, in the order the arms are reported. Weights are relative. */
  split: Record<string, number>;
  control: string;
  level: number;
  srmAlpha: number;
  /** Pre-period value per user, for CUPED. */
  covariates?: ReadonlyMap<string, number>;
}

export interface ArmReport {
  arm: string;
  users: number;
  requests: number;
  /** Interval with the user as the unit. Null when the arm cannot support one (see the findings). */
  clustered: RatioInterval | null;
  /** The same formula with each request as the unit, as if requests were independent. */
  naive: RatioInterval | null;
}

export interface ComparisonReport {
  arm: string;
  control: string;
  clustered: Difference;
  naive: Difference;
  clusteredExcludesZero: boolean;
  naiveExcludesZero: boolean;
  /** Width of the clustered interval divided by width of the request-level one. */
  intervalWidthRatio: number;
}

export interface CupedReport {
  theta: number;
  usersWithCovariate: number;
  usersImputed: number;
  comparisons: CupedComparison[];
}

export interface SrmReport {
  arms: string[];
  observed: number[];
  expected: number[];
  chi2: number;
  df: number;
  p: number;
  alpha: number;
  passed: boolean;
}

export interface ReadoutReport {
  rows: number;
  rowsIgnored: number;
  users: number;
  usersInMultipleArms: number;
  options: { split: Record<string, number>; control: string; level: number; srmAlpha: number };
  srm: SrmReport | null;
  arms: ArmReport[];
  comparisons: ComparisonReport[];
  cuped: CupedReport | null;
  findings: Finding[];
}

/** "control=0.5,treatment=0.5" or "control=1,treatment=1": relative weights in arm order. */
export function parseSplit(text: string): Record<string, number> {
  const split: Record<string, number> = {};
  const parts = text.split(',').map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? '' : part.slice(0, eq).trim();
    const weightText = eq < 0 ? '' : part.slice(eq + 1).trim();
    const weight = Number(weightText);
    if (name === '' || weightText === '' || !Number.isFinite(weight) || weight <= 0) {
      throw new Error(`invalid split "${text}": write arm=weight pairs with positive weights, such as control=0.5,treatment=0.5`);
    }
    if (Object.hasOwn(split, name)) throw new Error(`invalid split "${text}": arm "${name}" appears twice`);
    split[name] = weight;
  }
  if (Object.keys(split).length < 2) throw new Error(`invalid split "${text}": a split needs at least two arms`);
  return split;
}

interface UserRecord {
  arm: string;
  conflict: boolean;
  sumY: number;
  sumX: number;
  rows: Moments2;
}

function fmtP(p: number): string {
  return p === 0 ? '0' : p < 1e-3 ? p.toExponential(2) : p.toFixed(4);
}

export class ReadoutAccumulator {
  private readonly users = new Map<string, UserRecord>();
  private rows = 0;
  private rowsIgnored = 0;
  private readonly unplanned = new Map<string, number>();
  private readonly armNames: string[];

  constructor(private readonly options: ReadoutOptions) {
    this.armNames = Object.keys(options.split);
    if (!this.armNames.includes(options.control)) {
      throw new Error(`control arm "${options.control}" is not in the split (${this.armNames.join(', ')})`);
    }
  }

  add(row: ReadoutRow): void {
    this.rows++;
    if (!Object.hasOwn(this.options.split, row.arm)) {
      this.rowsIgnored++;
      this.unplanned.set(row.arm, (this.unplanned.get(row.arm) ?? 0) + 1);
      return;
    }
    let rec = this.users.get(row.userId);
    if (!rec) {
      rec = { arm: row.arm, conflict: false, sumY: 0, sumX: 0, rows: new Moments2() };
      this.users.set(row.userId, rec);
    } else if (rec.arm !== row.arm) {
      rec.conflict = true;
    }
    rec.sumY += row.y;
    rec.sumX += row.x;
    rec.rows.push(row.y, row.x);
  }

  finish(): ReadoutReport {
    const { split, control, level, srmAlpha } = this.options;
    const findings: Finding[] = [];
    const report: ReadoutReport = {
      rows: this.rows,
      rowsIgnored: this.rowsIgnored,
      users: 0,
      usersInMultipleArms: 0,
      options: { split, control, level, srmAlpha },
      srm: null,
      arms: [],
      comparisons: [],
      cuped: null,
      findings,
    };
    if (this.rows === 0) {
      findings.push({ type: 'no-events', message: 'the input held no rows, so nothing was checked' });
      return report;
    }
    if (this.unplanned.size > 0) {
      const list = [...this.unplanned.entries()].map(([arm, n]) => `${arm} (${n} rows)`).join(', ');
      findings.push({ type: 'unplanned-arm', message: `rows name arms that are not in the split and were left out: ${list}` });
    }

    const perArm = new Map<string, Array<[string, UserRecord]>>(this.armNames.map((a) => [a, []]));
    for (const [id, rec] of this.users) {
      if (rec.conflict) report.usersInMultipleArms++;
      else perArm.get(rec.arm)!.push([id, rec]);
    }
    if (report.usersInMultipleArms > 0) {
      findings.push({
        type: 'user-in-multiple-arms',
        message: `${report.usersInMultipleArms} user${report.usersInMultipleArms === 1 ? '' : 's'} appear in more than one arm and are left out of every number below`,
      });
    }
    report.users = [...perArm.values()].reduce((a, list) => a + list.length, 0);
    if (report.users === 0) {
      findings.push({ type: 'no-events', message: 'no user is in exactly one planned arm, so nothing was checked' });
      return report;
    }

    const observed = this.armNames.map((a) => perArm.get(a)!.length);
    const weights = this.armNames.map((a) => split[a]!);
    const srm = srmTest(observed, weights);
    const passed = srm.p >= srmAlpha;
    report.srm = { arms: this.armNames, observed, expected: srm.expected, chi2: srm.chi2, df: srm.df, p: srm.p, alpha: srmAlpha, passed };
    if (!passed) {
      const planned = weights.map((w) => w).join(':');
      findings.push({
        type: 'sample-ratio-mismatch',
        message:
          `users per arm are ${this.armNames.map((a, i) => `${a} ${observed[i]}`).join(', ')} against a planned ${planned} split ` +
          `(expected ${srm.expected.map((e) => e.toFixed(1)).join(', ')}); chi-square ${srm.chi2.toFixed(2)} on ${srm.df} df, p = ${fmtP(srm.p)} is below ${srmAlpha}`,
      });
    }

    for (const arm of this.armNames) {
      const list = perArm.get(arm)!;
      const entry: ArmReport = { arm, users: list.length, requests: 0, clustered: null, naive: null };
      const byUser = new Moments2();
      const byRow = new Moments2();
      for (const [, rec] of list) {
        byUser.push(rec.sumY, rec.sumX);
        byRow.merge(rec.rows);
      }
      entry.requests = byRow.n;
      if (list.length < 2) {
        findings.push({ type: 'too-few-users', message: `arm "${arm}" has ${list.length} user${list.length === 1 ? '' : 's'}; an interval needs at least 2` });
      } else if (byUser.meanX === 0) {
        findings.push({ type: 'zero-denominator', message: `arm "${arm}" has a denominator that sums to zero, so its ratio is undefined` });
      } else {
        entry.clustered = ratioInterval(byUser, level);
        entry.naive = ratioInterval(byRow, level);
      }
      report.arms.push(entry);
    }

    const controlArm = report.arms.find((a) => a.arm === control)!;
    for (const a of report.arms) {
      if (a.arm === control || !a.clustered || !a.naive || !controlArm.clustered || !controlArm.naive) continue;
      const clustered = ratioDifference(a.clustered, controlArm.clustered, level);
      const naive = ratioDifference(a.naive, controlArm.naive, level);
      report.comparisons.push({
        arm: a.arm,
        control,
        clustered,
        naive,
        clusteredExcludesZero: clustered.lower > 0 || clustered.upper < 0,
        naiveExcludesZero: naive.lower > 0 || naive.upper < 0,
        intervalWidthRatio: clustered.se / naive.se,
      });
    }

    const covariates = this.options.covariates;
    if (covariates && report.arms.every((a) => a.users >= 2)) {
      report.cuped = this.cupedReport(perArm, covariates, level, control);
    }
    return report;
  }

  private cupedReport(perArm: Map<string, Array<[string, UserRecord]>>, covariates: ReadonlyMap<string, number>, level: number, control: string): CupedReport {
    let known = 0;
    let knownSum = 0;
    for (const list of perArm.values()) {
      for (const [id] of list) {
        const c = covariates.get(id);
        if (c !== undefined) {
          known++;
          knownSum += c;
        }
      }
    }
    if (known === 0) throw new Error('the covariates file matches none of the users in the data (check that user ids agree)');
    const fill = knownSum / known;
    const arms: Record<string, { y: number[]; c: number[] }> = {};
    let imputed = 0;
    for (const [arm, list] of perArm) {
      const y: number[] = [];
      const c: number[] = [];
      for (const [id, rec] of list) {
        y.push(rec.sumY);
        const value = covariates.get(id);
        if (value === undefined) imputed++;
        c.push(value ?? fill);
      }
      arms[arm] = { y, c };
    }
    const result = cuped(arms, control, level);
    return { theta: result.theta, usersWithCovariate: known, usersImputed: imputed, comparisons: result.comparisons };
  }
}

async function* jsonlObjects(path: string): AsyncGenerator<{ obj: Record<string, unknown>; line: number }> {
  try {
    accessSync(path, constants.R_OK);
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`);
  }
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const raw of rl) {
      line++;
      const text = line === 1 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      if (text.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`${path}:${line}: not valid JSON: ${(e as Error).message}`);
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${path}:${line}: expected a JSON object`);
      }
      yield { obj: parsed as Record<string, unknown>, line };
    }
  } finally {
    rl.close();
  }
}

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export async function* readRows(path: string): AsyncGenerator<ReadoutRow> {
  for await (const { obj, line } of jsonlObjects(path)) {
    const where = `${path}:${line}:`;
    if (typeof obj['user_id'] !== 'string' || obj['user_id'] === '') throw new Error(`${where} user_id must be a non-empty string`);
    if (typeof obj['arm'] !== 'string' || obj['arm'] === '') throw new Error(`${where} arm must be a non-empty string`);
    if (!finiteNumber(obj['y'])) throw new Error(`${where} y must be a finite number`);
    if (obj['x'] !== undefined && !finiteNumber(obj['x'])) throw new Error(`${where} x must be a finite number`);
    yield { userId: obj['user_id'], arm: obj['arm'], y: obj['y'], x: obj['x'] === undefined ? 1 : (obj['x'] as number) };
  }
}

export async function readCovariates(path: string): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for await (const { obj, line } of jsonlObjects(path)) {
    const where = `${path}:${line}:`;
    if (typeof obj['user_id'] !== 'string' || obj['user_id'] === '') throw new Error(`${where} user_id must be a non-empty string`);
    if (!finiteNumber(obj['pre'])) throw new Error(`${where} pre must be a finite number`);
    if (map.has(obj['user_id'])) throw new Error(`${where} user "${obj['user_id']}" appears twice`);
    map.set(obj['user_id'], obj['pre']);
  }
  if (map.size === 0) throw new Error(`${path} holds no covariates`);
  return map;
}

export async function runReadout(path: string, options: ReadoutOptions): Promise<ReadoutReport> {
  const acc = new ReadoutAccumulator(options);
  for await (const row of readRows(path)) acc.add(row);
  return acc.finish();
}
