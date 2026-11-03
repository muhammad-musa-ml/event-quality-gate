import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkLines } from '../src/check-stream.js';
import { lintPaths } from '../src/lint-code.js';
import { loadPlan } from '../src/plan.js';
import { runReadout } from '../src/readout.js';
import { DEMO_SEED, DEMO_USERS_PER_ARM, buildExamples, demoExperiment, disagrees } from '../scripts/make-examples.js';
import { repoRoot } from '../scripts/paths.js';

const root = repoRoot();
const plan = loadPlan(join(root, 'examples', 'tracking-plan.json'));

describe('the committed example files', () => {
  it('are exactly what the generator writes from its seeds', () => {
    for (const [rel, text] of buildExamples()) {
      expect(readFileSync(join(root, rel), 'utf8') === text, rel).toBe(true);
    }
  });

  it('pass or fail as the README says', async () => {
    const clean = lintPaths([join(root, 'examples/code/clean')], plan, { trackers: ['track', 'analytics.track'], cwd: root });
    expect(clean.findings).toEqual([]);
    const faulty = lintPaths([join(root, 'examples/code/faulty')], plan, { trackers: ['track', 'analytics.track'], cwd: root });
    expect(new Set(faulty.findings.map((f) => f.type))).toEqual(
      new Set(['unknown-event', 'missing-required-property', 'unexpected-property', 'type-mismatch', 'enum-violation', 'non-literal-event-name', 'pii-shaped-value', 'unverifiable-properties']),
    );
    const cleanStream = readFileSync(join(root, 'examples/streams/clean.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(checkLines(cleanStream, plan).findingsTotal).toBe(0);
    const faultyStream = readFileSync(join(root, 'examples/streams/faulty.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(Object.keys(checkLines(faultyStream, plan).counts)).toHaveLength(13);
    const base = { split: { control: 1, treatment: 1 }, control: 'control', level: 0.95, srmAlpha: 0.001 };
    expect((await runReadout(join(root, 'examples/experiment/clean.jsonl'), base)).findings).toEqual([]);
    expect((await runReadout(join(root, 'examples/experiment/srm.jsonl'), base)).findings.map((f) => f.type)).toEqual(['sample-ratio-mismatch']);
  });

  it('show the disagreement the README describes, for the seed it names', () => {
    expect(disagrees(demoExperiment(DEMO_SEED, DEMO_USERS_PER_ARM, DEMO_USERS_PER_ARM).rows)).toBe(true);
  });
});
