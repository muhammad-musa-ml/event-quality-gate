import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLines } from '../src/check-stream.js';
import { lintSource } from '../src/lint-code.js';
import { loadPlan } from '../src/plan.js';
import { buildCorpus, randomCall } from '../scripts/code-corpus.js';
import { CODE_FAMILIES, STREAM_FAMILIES, runCodeFamily, scoreStream } from '../scripts/fault-injection.js';
import { repoRoot } from '../scripts/paths.js';
import { Rng, generateCleanStream } from '../scripts/synthetic.js';

const plan = loadPlan(join(repoRoot(), 'examples', 'tracking-plan.json'));
const N = 12;

describe('the fault-injection harness, at small size', () => {
  const clean = generateCleanStream({ users: 400, seed: 9 });

  for (const family of STREAM_FAMILIES) {
    it(`stream family ${family.id}: injects ${N} faults and the tool does what the family says`, () => {
      const events = clean.map((e) => structuredClone(e));
      const { lines, faults } = family.run(events, new Rng(5), N);
      expect(faults).toHaveLength(N);
      const report = checkLines(lines, plan, { examplesPerType: Number.MAX_SAFE_INTEGER });
      const { detected, stray } = scoreStream(report, faults);
      if (family.expectation === 'detected') expect(detected).toBe(N);
      else expect(detected).toBe(0);
      expect(stray).toBe(0);
    });
  }

  it('leaves the clean stream with no findings', () => {
    expect(checkLines(clean.map((e) => JSON.stringify(e)), plan).findingsTotal).toBe(0);
  });

  it('scores a fault only when the finding is at the injected line', () => {
    const lines = clean.slice(0, 20).map((e) => JSON.stringify(e));
    lines[4] = lines[4]!.slice(0, 30);
    const report = checkLines(lines, plan, { examplesPerType: Number.MAX_SAFE_INTEGER });
    expect(scoreStream(report, [{ line: 5, expect: 'invalid-json' }]).detected).toBe(1);
    expect(scoreStream(report, [{ line: 6, expect: 'invalid-json' }]).detected).toBe(0);
    expect(scoreStream(report, [{ line: 5, expect: 'invalid-json' }]).stray).toBe(0);
    expect(scoreStream(report, []).stray).toBe(1);
  });
});

describe('the code corpus', () => {
  it('has no findings when no fault is injected, in all three file kinds', () => {
    const rng = new Rng(3);
    const corpus = buildCorpus(Array.from({ length: 300 }, () => randomCall(rng)), 20);
    expect([...corpus.files.keys()].map((f) => f.split('.').pop())).toContain('tsx');
    expect([...corpus.files.keys()].map((f) => f.split('.').pop())).toContain('js');
    let findings = 0;
    for (const [file, text] of corpus.files) findings += lintSource(file, text, plan, ['track', 'analytics.track']).findings.length;
    expect(findings).toBe(0);
  });

  it('records the line of every call and property', () => {
    const rng = new Rng(4);
    const sites = Array.from({ length: 40 }, () => randomCall(rng));
    const corpus = buildCorpus(sites, 20);
    corpus.placed.forEach((p, i) => {
      const lines = corpus.files.get(p.file)!.split('\n');
      expect(lines[p.line - 1]).toContain(sites[i]!.callee);
      for (const [key, line] of Object.entries(p.propLine)) expect(lines[line - 1]).toContain(key);
    });
  });

  for (const family of CODE_FAMILIES) {
    it(`code family ${family.id}: ${family.expectation}`, () => {
      const r = runCodeFamily(plan, family, 1, N);
      expect(r.injected).toBe(N);
      expect(r.exact + r.unverifiable + r.missed).toBe(N);
      expect(r.stray).toBe(0);
      if (family.expectation === 'detected') expect(r.exact).toBe(N);
      if (family.expectation === 'flagged as unverifiable') expect(r.unverifiable).toBe(N);
      if (family.expectation === 'missed by design') expect(r.missed).toBe(N);
    });
  }
});
