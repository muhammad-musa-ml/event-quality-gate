import { describe, expect, it } from 'vitest';
import { Moments2, chiSquareSf, cuped, normalQuantile, ratioDifference, ratioInterval, srmTest } from '../src/stats.js';

function momentsOf(y: number[], x: number[]): Moments2 {
  const m = new Moments2();
  y.forEach((v, i) => m.push(v, x[i]!));
  return m;
}

// Reference values below were computed outside this code base: normal quantiles with Python's
// statistics.NormalDist().inv_cdf, and chi-square tail areas from closed forms for 1 to 4 degrees of
// freedom (1: erfc(sqrt(x/2)); 2: exp(-x/2); 3: erfc(sqrt(x/2)) + sqrt(2x/pi) exp(-x/2); 4: exp(-x/2)(1 + x/2)).

describe('normalQuantile', () => {
  const known: Array<[number, number]> = [
    [0.975, 1.9599639845400536],
    [0.995, 2.5758293035489],
    [0.95, 1.6448536269514715],
    [0.9995, 3.2905267314919255],
    [0.001, -3.090232306167813],
    [1e-10, -6.361340902404056],
  ];
  for (const [p, z] of known) {
    it(`p=${p}`, () => expect(Math.abs(normalQuantile(p) - z)).toBeLessThan(1e-8));
  }
  it('is 0 at the median and odd around it', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
    for (const p of [0.01, 0.2, 0.4, 0.49]) expect(normalQuantile(1 - p)).toBeCloseTo(-normalQuantile(p), 10);
  });
  it('is increasing', () => {
    let last = -Infinity;
    for (let p = 0.001; p < 1; p += 0.001) {
      const z = normalQuantile(p);
      expect(z).toBeGreaterThan(last);
      last = z;
    }
  });
  it('refuses p outside (0, 1)', () => {
    for (const p of [0, 1, -0.1, 1.5, Number.NaN]) expect(() => normalQuantile(p)).toThrowError(RangeError);
  });
});

describe('chiSquareSf', () => {
  const known: Array<[number, number, number]> = [
    [1, 1, 0.31731050786291404],
    [3.841458820694124, 1, 0.05],
    [10.827566170662733, 1, 0.001],
    [20000 / 5100, 1, 0.04767038065616144],
    [50, 1, 1.5374597944280351e-12],
    [2, 2, 0.36787944117144233],
    [5.991464547107979, 2, 0.05],
    [1, 3, 0.8012519569012008],
    [7.814727903251179, 3, 0.05],
    [4, 4, 0.4060058497098381],
    [9.487729036781154, 4, 0.05],
  ];
  for (const [x, df, p] of known) {
    it(`x=${x}, df=${df}`, () => expect(Math.abs(chiSquareSf(x, df) - p)).toBeLessThan(Math.max(1e-12, p * 1e-9)));
  }
  it('is 1 at zero and decreasing in x', () => {
    expect(chiSquareSf(0, 3)).toBe(1);
    let last = 1;
    for (let x = 0.5; x < 60; x += 0.5) {
      const p = chiSquareSf(x, 5);
      expect(p).toBeLessThan(last);
      last = p;
    }
  });
  it('is increasing in the degrees of freedom', () => {
    expect(chiSquareSf(5, 2)).toBeLessThan(chiSquareSf(5, 4));
    expect(chiSquareSf(5, 4)).toBeLessThan(chiSquareSf(5, 8));
  });
  it('refuses bad arguments', () => {
    expect(() => chiSquareSf(1, 0)).toThrowError(RangeError);
    expect(() => chiSquareSf(1, 1.5)).toThrowError(RangeError);
    expect(() => chiSquareSf(-1, 1)).toThrowError(RangeError);
    expect(() => chiSquareSf(Number.NaN, 1)).toThrowError(RangeError);
  });
});

describe('srmTest', () => {
  it('hand-computed: 5000 vs 5200 users on a 50/50 split', () => {
    // N = 10200, so each arm is expected to have 5100.
    // chi2 = (5000 - 5100)^2 / 5100 + (5200 - 5100)^2 / 5100 = 10000/5100 + 10000/5100 = 20000/5100 = 3.92157
    // df = 2 arms - 1 = 1, and the tail area at 3.92157 with 1 df is 0.047670 (erfc(sqrt(3.92157 / 2))).
    const r = srmTest([5000, 5200], [0.5, 0.5]);
    expect(r.total).toBe(10200);
    expect(r.expected).toEqual([5100, 5100]);
    expect(r.chi2).toBeCloseTo(20000 / 5100, 12);
    expect(r.df).toBe(1);
    expect(r.p).toBeCloseTo(0.04767038065616144, 9);
  });

  it('hand-computed: three arms, 3300 / 3400 / 3300 on an equal split', () => {
    // N = 10000, expected 3333.33 each. Deviations: -33.33, +66.67, -33.33.
    // chi2 = (1111.11 + 4444.44 + 1111.11) / 3333.33 = 6666.67 / 3333.33 = 2 exactly.
    // df = 2, so the tail area is exp(-2/2) = exp(-1) = 0.367879.
    const r = srmTest([3300, 3400, 3300], [1, 1, 1]);
    expect(r.chi2).toBeCloseTo(2, 10);
    expect(r.df).toBe(2);
    expect(r.p).toBeCloseTo(Math.exp(-1), 10);
  });

  it('normalises weights, so 1:1 and 0.5:0.5 and 50:50 agree', () => {
    const a = srmTest([4900, 5100], [1, 1]);
    const b = srmTest([4900, 5100], [0.5, 0.5]);
    const c = srmTest([4900, 5100], [50, 50]);
    expect(a.chi2).toBeCloseTo(b.chi2, 12);
    expect(a.chi2).toBeCloseTo(c.chi2, 12);
  });

  it('handles an uneven split: 90/10 with 9000 and 1000 users has chi2 = 0', () => {
    expect(srmTest([9000, 1000], [0.9, 0.1]).chi2).toBeCloseTo(0, 12);
    expect(srmTest([9000, 1000], [0.9, 0.1]).p).toBe(1);
  });

  it('gives a tiny p-value for a large imbalance', () => {
    // Expected 11000 each: chi2 = 2 * 1000^2 / 11000 = 181.82, df = 1.
    // p = erfc(sqrt(90.91)) ~ exp(-90.91) / (9.535 sqrt(pi)) = 3.3e-40 / 16.9 = 1.9e-41.
    const r = srmTest([10000, 12000], [0.5, 0.5]);
    expect(r.chi2).toBeCloseTo(181.8181818, 6);
    expect(r.p).toBeLessThan(3e-41);
    expect(r.p).toBeGreaterThan(1e-41);
  });

  it('refuses unusable input', () => {
    expect(() => srmTest([1], [1])).toThrowError(/at least two/);
    expect(() => srmTest([1, 2], [1])).toThrowError(/same length/);
    expect(() => srmTest([0, 0], [1, 1])).toThrowError(/no users/);
    expect(() => srmTest([1, -2], [1, 1])).toThrowError(/non-negative/);
    expect(() => srmTest([1, 2], [1, 0])).toThrowError(/positive/);
    expect(() => srmTest([1.5, 2], [1, 1])).toThrowError(/counts/);
  });
});

describe('Moments2', () => {
  it('matches a direct two-pass computation on random data', () => {
    let seed = 12345;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let trial = 0; trial < 50; trial++) {
      const n = 2 + Math.floor(rand() * 200);
      const y = Array.from({ length: n }, () => 1e6 + rand() * 100);
      const x = Array.from({ length: n }, () => 5 + rand() * 3);
      const m = momentsOf(y, x);
      const ybar = y.reduce((a, b) => a + b, 0) / n;
      const xbar = x.reduce((a, b) => a + b, 0) / n;
      let syy = 0;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < n; i++) {
        syy += (y[i]! - ybar) ** 2;
        sxx += (x[i]! - xbar) ** 2;
        sxy += (y[i]! - ybar) * (x[i]! - xbar);
      }
      expect(m.n).toBe(n);
      expect(m.meanY).toBeCloseTo(ybar, 8);
      expect(m.meanX).toBeCloseTo(xbar, 10);
      expect(m.varY()).toBeCloseTo(syy / (n - 1), 6);
      expect(m.varX()).toBeCloseTo(sxx / (n - 1), 8);
      expect(m.covXY()).toBeCloseTo(sxy / (n - 1), 6);
    }
  });
});

describe('Moments2.merge', () => {
  it('equals pushing every pair into one accumulator', () => {
    const y = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
    const x = [2, 7, 1, 8, 2, 8, 1, 8, 2, 8, 4];
    const whole = momentsOf(y, x);
    const left = momentsOf(y.slice(0, 4), x.slice(0, 4));
    const middle = momentsOf(y.slice(4, 5), x.slice(4, 5));
    const right = momentsOf(y.slice(5), x.slice(5));
    const merged = new Moments2();
    merged.merge(new Moments2());
    merged.merge(left);
    merged.merge(middle);
    merged.merge(right);
    expect(merged.n).toBe(whole.n);
    expect(merged.meanX).toBeCloseTo(whole.meanX, 12);
    expect(merged.meanY).toBeCloseTo(whole.meanY, 12);
    expect(merged.varX()).toBeCloseTo(whole.varX(), 10);
    expect(merged.varY()).toBeCloseTo(whole.varY(), 10);
    expect(merged.covXY()).toBeCloseTo(whole.covXY(), 10);
  });

  it('leaves the accumulator alone when the other one is empty', () => {
    const m = momentsOf([1, 2, 3], [4, 5, 7]);
    const before = [m.n, m.meanX, m.meanY, m.varX(), m.varY(), m.covXY()];
    m.merge(new Moments2());
    expect([m.n, m.meanX, m.meanY, m.varX(), m.varY(), m.covXY()]).toEqual(before);
  });
});

describe('ratioInterval: the delta method', () => {
  const z = 1.9599639845400536;

  it('hand-computed: four users, requests x = [2, 4, 3, 3], successes y = [1, 2, 1, 2]', () => {
    // n = 4. xbar = 12/4 = 3, ybar = 6/4 = 1.5, so R = ybar / xbar = 0.5.
    // dx = x - 3 = [-1, 1, 0, 0] and dy = y - 1.5 = [-0.5, 0.5, -0.5, 0.5].
    // s2x  = (1 + 1 + 0 + 0) / 3                          = 2/3
    // s2y  = (0.25 + 0.25 + 0.25 + 0.25) / 3              = 1/3
    // sxy  = ((-1)(-0.5) + (1)(0.5) + 0 + 0) / 3          = 1/3
    // Var(R) = (1/n) (s2y - 2 R sxy + R^2 s2x) / xbar^2
    //        = (1/4) (1/3 - 2(0.5)(1/3) + 0.25 (2/3)) / 9
    //        = (1/4) (1/3 - 1/3 + 1/6) / 9 = (1/4)(1/6)/9 = 1/216
    // se = sqrt(1/216) = 0.0680414, so the 95% interval is 0.5 +- 1.959964 * 0.0680414 = 0.5 +- 0.133359.
    const r = ratioInterval(momentsOf([1, 2, 1, 2], [2, 4, 3, 3]), 0.95);
    expect(r.n).toBe(4);
    expect(r.ybar).toBeCloseTo(1.5, 12);
    expect(r.xbar).toBeCloseTo(3, 12);
    expect(r.ratio).toBeCloseTo(0.5, 12);
    expect(r.variance).toBeCloseTo(1 / 216, 12);
    expect(r.se).toBeCloseTo(Math.sqrt(1 / 216), 12);
    expect(Math.abs(r.lower - (0.5 - 0.13335865767653637))).toBeLessThan(1e-7);
    expect(Math.abs(r.upper - (0.5 + 0.13335865767653637))).toBeLessThan(1e-7);
    expect(r.level).toBe(0.95);
  });

  it('hand-computed: users that are all-or-nothing give a wider interval than the same rows treated as independent', () => {
    // Four users with two requests each. Users 1 and 3 succeed on both requests, users 2 and 4 on neither.
    // Per user: y = [2, 0, 2, 0], x = [2, 2, 2, 2]. xbar = 2, ybar = 1, R = 0.5.
    // dx = 0 for everyone, so s2x = 0 and sxy = 0. dy = [1, -1, 1, -1], so s2y = 4/3.
    // Var(R) = (1/4) (4/3) / 2^2 = 1/12 = 0.083333, se = 0.288675, half-width 1.959964 * 0.288675 = 0.565793.
    const byUser = ratioInterval(momentsOf([2, 0, 2, 0], [2, 2, 2, 2]), 0.95);
    expect(byUser.variance).toBeCloseTo(1 / 12, 12);
    expect(byUser.upper - byUser.lower).toBeCloseTo(2 * 0.5657928670380858, 6);

    // The same data as 8 request rows, each with x = 1: four rows with y = 1 and four with y = 0.
    // N = 8, xbar = 1, ybar = 0.5, R = 0.5. s2y = 8 (0.25) / 7 = 2/7, s2x = 0, sxy = 0.
    // Var(R) = (1/8)(2/7) / 1 = 1/28 = 0.035714, se = 0.188982, half-width 0.370398.
    const byRequest = ratioInterval(momentsOf([1, 1, 0, 0, 1, 1, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1]), 0.95);
    expect(byRequest.ratio).toBeCloseTo(0.5, 12);
    expect(byRequest.variance).toBeCloseTo(1 / 28, 12);
    expect(byRequest.upper - byRequest.lower).toBeCloseTo(2 * 0.3703983772668733, 6);

    // Same estimate, and the user-level interval is sqrt((1/12)/(1/28)) = sqrt(7/3) = 1.5275 times wider.
    expect((byUser.upper - byUser.lower) / (byRequest.upper - byRequest.lower)).toBeCloseTo(Math.sqrt(7 / 3), 6);
  });

  it('with x = 1 for every unit it is the ordinary interval for a mean, ybar +- z s / sqrt(n)', () => {
    const y = [3, 5, 4, 8, 6, 2, 9];
    const r = ratioInterval(momentsOf(y, y.map(() => 1)), 0.95);
    const n = y.length;
    const mean = y.reduce((a, b) => a + b, 0) / n;
    const s2 = y.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    expect(r.ratio).toBeCloseTo(mean, 12);
    expect(r.se).toBeCloseTo(Math.sqrt(s2 / n), 12);
    expect(r.lower).toBeCloseTo(mean - z * Math.sqrt(s2 / n), 6);
  });

  it('uses the level it is given', () => {
    const m = momentsOf([1, 2, 1, 2], [2, 4, 3, 3]);
    const r90 = ratioInterval(m, 0.9);
    const r99 = ratioInterval(m, 0.99);
    expect((r90.upper - r90.ratio) / r90.se).toBeCloseTo(1.6448536269514715, 6);
    expect((r99.upper - r99.ratio) / r99.se).toBeCloseTo(2.5758293035489, 6);
  });

  it('leaves the ratio and its standard error unchanged when every x and y is scaled by the same constant', () => {
    const y = [1, 2, 1, 2];
    const x = [2, 4, 3, 3];
    const a = ratioInterval(momentsOf(y, x), 0.95);
    const b = ratioInterval(momentsOf(y.map((v) => v * 7), x.map((v) => v * 7)), 0.95);
    expect(b.ratio).toBeCloseTo(a.ratio, 12);
    expect(b.se).toBeCloseTo(a.se, 12);
  });

  it('is symmetric about the estimate', () => {
    const r = ratioInterval(momentsOf([1, 2, 1, 2, 5], [2, 4, 3, 3, 9]), 0.95);
    expect(r.ratio - r.lower).toBeCloseTo(r.upper - r.ratio, 12);
  });

  it('refuses what it cannot compute', () => {
    expect(() => ratioInterval(momentsOf([1], [1]), 0.95)).toThrowError(/at least 2/);
    expect(() => ratioInterval(momentsOf([1, 2], [0, 0]), 0.95)).toThrowError(/mean of the denominator is zero/);
    expect(() => ratioInterval(momentsOf([1, 2], [1, 1]), 1)).toThrowError(RangeError);
    expect(() => ratioInterval(momentsOf([1, 2], [1, 1]), 0)).toThrowError(RangeError);
  });
});

describe('ratioDifference', () => {
  it('subtracts the estimates and adds the variances of two independent arms', () => {
    // Arm A: R = 0.5, Var = 1/216.  Arm B: R = 0.5, Var = 1/12. Difference B - A = 0, Var = 1/216 + 1/12 = 19/216.
    const a = ratioInterval(momentsOf([1, 2, 1, 2], [2, 4, 3, 3]), 0.95);
    const b = ratioInterval(momentsOf([2, 0, 2, 0], [2, 2, 2, 2]), 0.95);
    const d = ratioDifference(b, a, 0.95);
    expect(d.diff).toBeCloseTo(0, 12);
    expect(d.variance).toBeCloseTo(1 / 216 + 1 / 12, 12);
    expect(d.lower).toBeCloseTo(-1.9599639845400536 * Math.sqrt(19 / 216), 6);
    expect(d.relative).toBeCloseTo(0, 12);
  });

  it('reports the difference relative to the control estimate', () => {
    const lo = ratioInterval(momentsOf([1, 2, 1, 2], [2, 4, 3, 3]), 0.95);
    const hi = ratioInterval(momentsOf([3, 4, 3, 4], [2, 4, 3, 3]), 0.95);
    const d = ratioDifference(hi, lo, 0.95);
    expect(d.diff).toBeCloseTo(hi.ratio - lo.ratio, 12);
    expect(d.relative).toBeCloseTo((hi.ratio - lo.ratio) / lo.ratio, 12);
  });
});

describe('cuped', () => {
  // Two arms of four users. Pre-period covariate c = [1, 2, 3, 4] in both arms.
  // control y = [3, 3, 5, 9], treatment y = [3, 7, 9, 9].
  const arms = {
    control: { y: [3, 3, 5, 9], c: [1, 2, 3, 4] },
    treatment: { y: [3, 7, 9, 9], c: [1, 2, 3, 4] },
  };

  it('hand-computed: theta = 2, the same difference, and a variance cut to one sixth', () => {
    // Covariate mean is 2.5 in both arms, so dc = [-1.5, -0.5, 0.5, 1.5] and sum(dc^2) = 5 per arm.
    // control:   ybar = 5, dy = [-2, -2, 0, 4];  sum(dc*dy) = 3 + 1 + 0 + 6 = 10;  sum(dy^2) = 24, s2 = 24/3 = 8
    // treatment: ybar = 7, dy = [-4, 0, 2, 2];  sum(dc*dy) = 6 + 0 + 1 + 3 = 10;  sum(dy^2) = 24, s2 = 24/3 = 8
    // theta = (10 + 10) / (5 + 5) = 2.   Adjusted y = y - 2 (c - 2.5):
    //   control   [3-2+5, 3-4+5, 5-6+5, 9-8+5] = [6, 4, 4, 6]   mean 5, deviations [1,-1,-1,1],   s2 = 4/3
    //   treatment [3-2+5, 7-4+5, 9-6+5, 9-8+5] = [6, 8, 8, 6]   mean 7, deviations [-1,1,1,-1],  s2 = 4/3
    // Difference of means: 7 - 5 = 2 before and after the adjustment.
    // Var(diff): before 8/4 + 8/4 = 4 (se 2); after (4/3)/4 + (4/3)/4 = 2/3 (se 0.816497). Ratio (2/3)/4 = 1/6.
    const r = cuped(arms, 'control', 0.95);
    expect(r.theta).toBeCloseTo(2, 12);
    expect(r.comparisons).toHaveLength(1);
    const c = r.comparisons[0]!;
    expect(c.arm).toBe('treatment');
    expect(c.raw.diff).toBeCloseTo(2, 12);
    expect(c.adjusted.diff).toBeCloseTo(2, 12);
    expect(c.raw.variance).toBeCloseTo(4, 12);
    expect(c.adjusted.variance).toBeCloseTo(2 / 3, 12);
    expect(c.varianceRatio).toBeCloseTo(1 / 6, 12);
    expect(c.adjusted.se).toBeCloseTo(0.816496580927726, 10);
    expect(c.adjusted.lower).toBeCloseTo(2 - 1.9599639845400536 * Math.sqrt(2 / 3), 6);
    expect(c.raw.upper).toBeCloseTo(2 + 1.9599639845400536 * 2, 6);
  });

  it('removes the shift when the covariate means differ between arms by chance', () => {
    // Treatment users start 1 higher on the covariate and their outcome rises by 2 per unit of covariate,
    // with a true effect of 0: raw difference is 2 (from the covariate), adjusted difference is 0.
    const shifted = {
      control: { y: [2, 4, 6, 8], c: [1, 2, 3, 4] },
      treatment: { y: [4, 6, 8, 10], c: [2, 3, 4, 5] },
    };
    const r = cuped(shifted, 'control', 0.95).comparisons[0]!;
    expect(r.raw.diff).toBeCloseTo(2, 12);
    expect(r.adjusted.diff).toBeCloseTo(0, 12);
  });

  it('does nothing when the covariate carries no information', () => {
    const flat = { control: { y: [1, 2, 3, 4], c: [5, 5, 5, 5] }, treatment: { y: [2, 3, 4, 6], c: [5, 5, 5, 5] } };
    const r = cuped(flat, 'control', 0.95);
    expect(r.theta).toBe(0);
    expect(r.comparisons[0]!.varianceRatio).toBeCloseTo(1, 12);
    expect(r.comparisons[0]!.adjusted.diff).toBeCloseTo(r.comparisons[0]!.raw.diff, 12);
  });

  it('compares each other arm with the control arm', () => {
    const three = { ...arms, other: { y: [3, 7, 9, 9], c: [1, 2, 3, 4] } };
    expect(cuped(three, 'control', 0.95).comparisons.map((c) => c.arm)).toEqual(['treatment', 'other']);
  });

  it('refuses unusable input', () => {
    expect(() => cuped(arms, 'missing', 0.95)).toThrowError(/control arm/);
    expect(() => cuped({ control: { y: [1, 2], c: [1] }, treatment: arms.treatment }, 'control', 0.95)).toThrowError(/same length/);
    expect(() => cuped({ control: { y: [1], c: [1] }, treatment: arms.treatment }, 'control', 0.95)).toThrowError(/at least 2/);
  });
});
