// Numerical building blocks for the readout checks. No dependencies.

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function lnGamma(z: number): number {
  if (z < 0.5) return lnGamma(z + 1) - Math.log(z);
  const x = z - 1;
  let sum = LANCZOS[0]!;
  for (let i = 1; i < 9; i++) sum += LANCZOS[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

const EPS = 1e-16;
const TINY = 1e-300;

/** Regularised upper incomplete gamma function Q(a, x). */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let i = 0; i < 100_000; i++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) break;
    }
    return 1 - sum * front;
  }
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 100_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return front * h;
}

/** Upper-tail probability of a chi-square variable with `df` degrees of freedom. */
export function chiSquareSf(x: number, df: number): number {
  if (!Number.isInteger(df) || df < 1) throw new RangeError(`degrees of freedom must be a positive integer, got ${df}`);
  if (!(x >= 0) || !Number.isFinite(x)) throw new RangeError(`chi-square statistic must be finite and non-negative, got ${x}`);
  if (x === 0) return 1;
  return Math.min(1, Math.max(0, gammaQ(df / 2, x / 2)));
}

function normalCdf(x: number): number {
  const tail = 0.5 * gammaQ(0.5, (x * x) / 2);
  return x < 0 ? tail : 1 - tail;
}

const A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];

/** Inverse of the standard normal distribution function: a rational approximation, then one Halley step. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`probability must be strictly between 0 and 1, got ${p}`);
  const plow = 0.02425;
  let x: number;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((C[0]! * q + C[1]!) * q + C[2]!) * q + C[3]!) * q + C[4]!) * q + C[5]!) / ((((D[0]! * q + D[1]!) * q + D[2]!) * q + D[3]!) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((A[0]! * r + A[1]!) * r + A[2]!) * r + A[3]!) * r + A[4]!) * r + A[5]!) * q) / (((((B[0]! * r + B[1]!) * r + B[2]!) * r + B[3]!) * r + B[4]!) * r + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export interface SrmResult {
  total: number;
  expected: number[];
  chi2: number;
  df: number;
  p: number;
}

/**
 * Chi-square goodness-of-fit test of the number of users assigned to each arm against the planned split.
 * `weights` are relative shares and are normalised, so 1:1, 0.5:0.5 and 50:50 are the same plan.
 */
export function srmTest(observed: readonly number[], weights: readonly number[]): SrmResult {
  if (observed.length < 2) throw new RangeError('a sample ratio test needs at least two arms');
  if (observed.length !== weights.length) throw new RangeError('observed counts and split weights must have the same length');
  if (observed.some((n) => !Number.isInteger(n) || n < 0)) throw new RangeError('arm counts must be non-negative integers');
  if (weights.some((w) => !(w > 0) || !Number.isFinite(w))) throw new RangeError('split weights must be positive numbers');
  const total = observed.reduce((a, b) => a + b, 0);
  if (total === 0) throw new RangeError('no users were assigned to any arm');
  const wsum = weights.reduce((a, b) => a + b, 0);
  const expected = weights.map((w) => (total * w) / wsum);
  let chi2 = 0;
  observed.forEach((o, i) => {
    const e = expected[i]!;
    chi2 += (o - e) ** 2 / e;
  });
  const df = observed.length - 1;
  return { total, expected, chi2, df, p: chiSquareSf(chi2, df) };
}

/** Running means, variances and covariance of (y, x) pairs, by Welford's update. Variances use n - 1. */
export class Moments2 {
  n = 0;
  meanX = 0;
  meanY = 0;
  private m2X = 0;
  private m2Y = 0;
  private cXY = 0;

  push(y: number, x: number): void {
    this.n += 1;
    const dx = x - this.meanX;
    this.meanX += dx / this.n;
    const dy = y - this.meanY;
    this.meanY += dy / this.n;
    this.m2X += dx * (x - this.meanX);
    this.m2Y += dy * (y - this.meanY);
    this.cXY += dx * (y - this.meanY);
  }

  /** Adds everything `other` has seen, as if its pairs had been pushed here (Chan's parallel update). */
  merge(other: Moments2): void {
    if (other.n === 0) return;
    if (this.n === 0) {
      this.n = other.n;
      this.meanX = other.meanX;
      this.meanY = other.meanY;
      this.m2X = other.m2X;
      this.m2Y = other.m2Y;
      this.cXY = other.cXY;
      return;
    }
    const n = this.n + other.n;
    const dx = other.meanX - this.meanX;
    const dy = other.meanY - this.meanY;
    const w = (this.n * other.n) / n;
    this.m2X += other.m2X + dx * dx * w;
    this.m2Y += other.m2Y + dy * dy * w;
    this.cXY += other.cXY + dx * dy * w;
    this.meanX += (dx * other.n) / n;
    this.meanY += (dy * other.n) / n;
    this.n = n;
  }

  varX(): number {
    return this.m2X / (this.n - 1);
  }

  varY(): number {
    return this.m2Y / (this.n - 1);
  }

  covXY(): number {
    return this.cXY / (this.n - 1);
  }
}

export interface RatioInterval {
  n: number;
  ybar: number;
  xbar: number;
  ratio: number;
  variance: number;
  se: number;
  lower: number;
  upper: number;
  level: number;
}

function checkLevel(level: number): void {
  if (!(level > 0 && level < 1)) throw new RangeError(`confidence level must be strictly between 0 and 1, got ${level}`);
}

/**
 * Interval for R = mean(y) / mean(x) over n units, by the delta method:
 *   Var(R) = (1/n) (s2_y - 2 R s_xy + R^2 s2_x) / mean(x)^2
 * with sample (n - 1) variances and covariance. A unit is whatever was randomised (a user) for the
 * clustered interval, or a single request for the naive one; the formula is the same.
 */
export function ratioInterval(m: Moments2, level: number): RatioInterval {
  checkLevel(level);
  if (m.n < 2) throw new RangeError(`the interval needs at least 2 units, got ${m.n}`);
  if (m.meanX === 0) throw new RangeError('the mean of the denominator is zero, so the ratio is undefined');
  const ratio = m.meanY / m.meanX;
  const raw = (m.varY() - 2 * ratio * m.covXY() + ratio * ratio * m.varX()) / (m.n * m.meanX * m.meanX);
  const variance = Math.max(0, raw);
  const se = Math.sqrt(variance);
  const z = normalQuantile(1 - (1 - level) / 2);
  return { n: m.n, ybar: m.meanY, xbar: m.meanX, ratio, variance, se, lower: ratio - z * se, upper: ratio + z * se, level };
}

export interface Difference {
  diff: number;
  variance: number;
  se: number;
  lower: number;
  upper: number;
  /** diff divided by the control estimate; null when that estimate is zero. */
  relative: number | null;
}

/** Treatment minus control for two independent arms (users are randomised, so the arms do not share units). */
export function ratioDifference(treatment: RatioInterval, control: RatioInterval, level: number): Difference {
  checkLevel(level);
  const diff = treatment.ratio - control.ratio;
  const variance = treatment.variance + control.variance;
  const se = Math.sqrt(variance);
  const z = normalQuantile(1 - (1 - level) / 2);
  return { diff, variance, se, lower: diff - z * se, upper: diff + z * se, relative: control.ratio === 0 ? null : diff / control.ratio };
}

export interface ArmData {
  /** One outcome per user. */
  y: readonly number[];
  /** The same quantity for the same user before the experiment started. */
  c: readonly number[];
}

export interface MeanDifference {
  diff: number;
  variance: number;
  se: number;
  lower: number;
  upper: number;
}

export interface CupedComparison {
  arm: string;
  raw: MeanDifference;
  adjusted: MeanDifference;
  /** Var(adjusted difference) / Var(raw difference). */
  varianceRatio: number;
}

export interface CupedResult {
  theta: number;
  comparisons: CupedComparison[];
}

function meanVar(values: readonly number[]): { n: number; mean: number; variance: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, mean, variance };
}

function difference(a: { n: number; mean: number; variance: number }, control: { n: number; mean: number; variance: number }, level: number): MeanDifference {
  const diff = a.mean - control.mean;
  const variance = a.variance / a.n + control.variance / control.n;
  const se = Math.sqrt(variance);
  const z = normalQuantile(1 - (1 - level) / 2);
  return { diff, variance, se, lower: diff - z * se, upper: diff + z * se };
}

/**
 * CUPED: y_adj = y - theta (c - mean(c)), where theta is the slope of y on the pre-period covariate c
 * pooled over the arms after centring each arm on its own mean. The adjusted outcome is compared between
 * arms like any other per-user outcome. The uncertainty in theta is not added to the variance.
 */
export function cuped(arms: Record<string, ArmData>, control: string, level: number): CupedResult {
  checkLevel(level);
  const names = Object.keys(arms);
  if (!Object.hasOwn(arms, control)) throw new RangeError(`control arm "${control}" is not among the arms (${names.join(', ')})`);
  let sxy = 0;
  let sxx = 0;
  let csum = 0;
  let cn = 0;
  for (const name of names) {
    const arm = arms[name]!;
    if (arm.y.length !== arm.c.length) throw new RangeError(`arm "${name}": outcomes and covariates must have the same length`);
    if (arm.y.length < 2) throw new RangeError(`arm "${name}" needs at least 2 users, got ${arm.y.length}`);
    const ybar = arm.y.reduce((a, b) => a + b, 0) / arm.y.length;
    const cbar = arm.c.reduce((a, b) => a + b, 0) / arm.c.length;
    arm.y.forEach((y, i) => {
      sxy += (arm.c[i]! - cbar) * (y - ybar);
      sxx += (arm.c[i]! - cbar) ** 2;
    });
    csum += arm.c.reduce((a, b) => a + b, 0);
    cn += arm.c.length;
  }
  const theta = sxx === 0 ? 0 : sxy / sxx;
  const cOverall = csum / cn;
  const raw = new Map<string, ReturnType<typeof meanVar>>();
  const adj = new Map<string, ReturnType<typeof meanVar>>();
  for (const name of names) {
    const arm = arms[name]!;
    raw.set(name, meanVar(arm.y));
    adj.set(name, meanVar(arm.y.map((y, i) => y - theta * (arm.c[i]! - cOverall))));
  }
  const comparisons: CupedComparison[] = [];
  for (const name of names) {
    if (name === control) continue;
    const r = difference(raw.get(name)!, raw.get(control)!, level);
    const a = difference(adj.get(name)!, adj.get(control)!, level);
    comparisons.push({ arm: name, raw: r, adjusted: a, varianceRatio: r.variance === 0 ? 1 : a.variance / r.variance });
  }
  return { theta, comparisons };
}
