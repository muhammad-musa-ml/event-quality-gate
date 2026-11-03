import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLines } from '../src/check-stream.js';
import { loadPlan } from '../src/plan.js';
import { ClusterModel, Rng, drawUser, generateCleanStream, toJsonl, trueRatio } from '../scripts/synthetic.js';

const planPath = fileURLToPath(new URL('../examples/tracking-plan.json', import.meta.url));
const plan = loadPlan(planPath);

describe('Rng', () => {
  it('repeats for a seed and differs between seeds', () => {
    const a = new Rng(7);
    const b = new Rng(7);
    const c = new Rng(8);
    const first = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(first);
  });

  it('keeps ints in range and shuffles without losing items', () => {
    const r = new Rng(1);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    r.shuffle(items);
    expect([...items].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('draws samples with the right means', () => {
    const r = new Rng(3);
    const n = 40_000;
    let beta = 0;
    let pois = 0;
    let gam = 0;
    let norm = 0;
    for (let i = 0; i < n; i++) {
      beta += r.beta(2, 6);
      pois += r.poisson(4);
      gam += r.gamma(0.5);
      norm += r.normal();
    }
    expect(beta / n).toBeCloseTo(2 / 8, 2);
    expect(pois / n).toBeCloseTo(4, 1);
    expect(gam / n).toBeCloseTo(0.5, 1);
    expect(Math.abs(norm / n)).toBeLessThan(0.03);
  });
});

describe('generateCleanStream', () => {
  const events = generateCleanStream({ users: 2000, seed: 1 });
  const lines = toJsonl(events).split('\n').filter(Boolean);

  it('is deterministic for a seed', () => {
    expect(toJsonl(generateCleanStream({ users: 50, seed: 4 }))).toBe(toJsonl(generateCleanStream({ users: 50, seed: 4 })));
    expect(toJsonl(generateCleanStream({ users: 50, seed: 4 }))).not.toBe(toJsonl(generateCleanStream({ users: 50, seed: 5 })));
  });

  it('is sorted by arrival time', () => {
    for (let i = 1; i < events.length; i++) expect(events[i]!.received_at).toBeGreaterThanOrEqual(events[i - 1]!.received_at);
  });

  it('passes the stream check with no findings, so the fault-injection baseline is clean', () => {
    const r = checkLines(lines, plan);
    expect(r.findingsTotal).toBe(0);
    expect(r.events).toBe(events.length);
    expect(r.users).toBe(2000);
    expect(events.length).toBeGreaterThan(8000);
  });

  it('uses every event in the plan', () => {
    expect(new Set(events.map((e) => e.name))).toEqual(new Set(Object.keys(plan.events)));
  });
});

describe('drawUser and trueRatio', () => {
  it('gives requests a within-user correlation of the stated size', () => {
    const model: ClusterModel = { p0: 0.3, icc: 0.2, meanRequests: 6 };
    const r = new Rng(11);
    const n = 60_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const p = drawUser(r, model).p;
      sum += p;
      sumSq += p * p;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(0.3, 2);
    expect(variance / (0.3 * 0.7)).toBeCloseTo(0.2, 1);
  });

  it('has requests independent of p unless asked, so the ratio is p0', () => {
    const model: ClusterModel = { p0: 0.25, icc: 0.3, meanRequests: 8 };
    expect(trueRatio(model)).toBe(0.25);
    const r = new Rng(12);
    let y = 0;
    let x = 0;
    for (let i = 0; i < 80_000; i++) {
      const u = drawUser(r, model);
      y += u.successes;
      x += u.requests;
    }
    expect(y / x).toBeCloseTo(0.25, 2);
  });

  it('matches the closed form when heavier users also succeed more often', () => {
    const model: ClusterModel = { p0: 0.2, icc: 0.4, meanRequests: 0, heavy: 20 };
    // E[p^2] = 0.04 + 0.2 * 0.8 * 0.4 = 0.104;  R = (0.2 + 20 * 0.104) / (1 + 20 * 0.2) = 2.28 / 5 = 0.456
    expect(trueRatio(model)).toBeCloseTo(0.456, 12);
    const r = new Rng(13);
    let y = 0;
    let x = 0;
    for (let i = 0; i < 100_000; i++) {
      const u = drawUser(r, model);
      y += u.successes;
      x += u.requests;
    }
    expect(y / x).toBeCloseTo(0.456, 2);
  });
});

describe('the committed example plan', () => {
  it('is the plan this generator targets', () => {
    expect(JSON.parse(readFileSync(planPath, 'utf8')).version).toBe(1);
  });
});
