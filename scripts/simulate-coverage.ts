// Coverage of the nominal 95% interval for a ratio metric when requests are correlated within a user.
//
// Generator (scripts/synthetic.ts, drawUser): each user has a success probability p_u drawn from a Beta
// distribution with mean p0 and intra-class correlation icc; the user makes 1 + Poisson(meanRequests - 1)
// requests (or 1 + Poisson(heavy * p_u) in the "heavy" setting), and each request succeeds with
// probability p_u. The true ratio is E[successes] / E[requests] in closed form (trueRatio).
// Each trial draws `users` users, then builds two intervals with the same function (ratioInterval):
//   naive      every request is a unit, as if requests were independent
//   clustered  every user is a unit (per-user successes over per-user requests), the delta method
// and records whether each contains the true ratio.
import { join } from 'node:path';
import { Moments2, ratioInterval } from '../src/stats.js';
import { runMeta, summarize, writeJson } from './meta.js';
import { isMain, repoRoot } from './paths.js';
import { Rng, drawUser, trueRatio } from './synthetic.js';
import type { ClusterModel } from './synthetic.js';

export interface Setting {
  id: string;
  label: string;
  users: number;
  model: ClusterModel;
}

export const SEEDS = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
export const TRIALS_PER_SEED = 2000;
export const LEVEL = 0.95;

export const SETTINGS: Setting[] = [
  { id: 'independent', label: 'requests independent (icc 0)', users: 200, model: { p0: 0.2, icc: 0, meanRequests: 10 } },
  { id: 'icc-0.05', label: 'icc 0.05', users: 200, model: { p0: 0.2, icc: 0.05, meanRequests: 10 } },
  { id: 'icc-0.2', label: 'icc 0.2', users: 200, model: { p0: 0.2, icc: 0.2, meanRequests: 10 } },
  { id: 'icc-0.5', label: 'icc 0.5', users: 200, model: { p0: 0.2, icc: 0.5, meanRequests: 10 } },
  { id: 'icc-0.2-small', label: 'icc 0.2, 50 users', users: 50, model: { p0: 0.2, icc: 0.2, meanRequests: 10 } },
  { id: 'icc-0.2-heavy', label: 'icc 0.2, heavy users succeed more', users: 200, model: { p0: 0.2, icc: 0.2, meanRequests: 0, heavy: 45 } },
];

export interface SeedResult {
  seed: number;
  trials: number;
  naiveCoverage: number;
  clusteredCoverage: number;
  naiveMeanWidth: number;
  clusteredMeanWidth: number;
}

export function runSeed(setting: Setting, seed: number, trials: number): SeedResult {
  const rng = new Rng(seed * 1000 + setting.id.length);
  const truth = trueRatio(setting.model);
  let naiveHits = 0;
  let clusteredHits = 0;
  let naiveWidth = 0;
  let clusteredWidth = 0;
  for (let t = 0; t < trials; t++) {
    const byUser = new Moments2();
    const byRequest = new Moments2();
    for (let u = 0; u < setting.users; u++) {
      const d = drawUser(rng, setting.model);
      byUser.push(d.successes, d.requests);
      for (let r = 0; r < d.requests; r++) byRequest.push(r < d.successes ? 1 : 0, 1);
    }
    const naive = ratioInterval(byRequest, LEVEL);
    const clustered = ratioInterval(byUser, LEVEL);
    if (naive.lower <= truth && truth <= naive.upper) naiveHits++;
    if (clustered.lower <= truth && truth <= clustered.upper) clusteredHits++;
    naiveWidth += naive.upper - naive.lower;
    clusteredWidth += clustered.upper - clustered.lower;
  }
  return {
    seed,
    trials,
    naiveCoverage: naiveHits / trials,
    clusteredCoverage: clusteredHits / trials,
    naiveMeanWidth: naiveWidth / trials,
    clusteredMeanWidth: clusteredWidth / trials,
  };
}

function main(): void {
  const root = repoRoot();
  const meta = runMeta(root);
  const started = Date.now();
  const settings = SETTINGS.map((setting) => {
    const perSeed = SEEDS.map((seed) => runSeed(setting, seed, TRIALS_PER_SEED));
    console.log(
      `${setting.id}: naive ${(summarize(perSeed.map((s) => s.naiveCoverage)).mean * 100).toFixed(1)}%, ` +
        `clustered ${(summarize(perSeed.map((s) => s.clusteredCoverage)).mean * 100).toFixed(1)}%`,
    );
    return {
      id: setting.id,
      label: setting.label,
      users: setting.users,
      model: setting.model,
      trueRatio: trueRatio(setting.model),
      perSeed,
      summary: {
        naive: summarize(perSeed.map((s) => s.naiveCoverage)),
        clustered: summarize(perSeed.map((s) => s.clusteredCoverage)),
        naiveMeanWidth: summarize(perSeed.map((s) => s.naiveMeanWidth)).mean,
        clusteredMeanWidth: summarize(perSeed.map((s) => s.clusteredMeanWidth)).mean,
      },
    };
  });
  const p = 0.95;
  writeJson(join(root, 'results', 'coverage', 'coverage.json'), {
    description:
      'Coverage of the nominal 95% interval for a ratio metric with requests correlated within a user: request-level (naive) against user-level (delta method). Synthetic data only.',
    command: 'node dist/scripts/simulate-coverage.js',
    level: LEVEL,
    seeds: SEEDS,
    trialsPerSeed: TRIALS_PER_SEED,
    trialsPerSetting: SEEDS.length * TRIALS_PER_SEED,
    monteCarloSePerSeed: Math.sqrt((p * (1 - p)) / TRIALS_PER_SEED),
    generator:
      'user success probability ~ Beta(mean p0, intra-class correlation icc); requests per user = 1 + Poisson(meanRequests - 1), or 1 + Poisson(heavy * p_u) in the heavy setting; each request succeeds with probability p_u',
    settings,
    meta,
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
  });
  console.log(`wrote results/coverage/coverage.json in ${Math.round((Date.now() - started) / 1000)} s`);
}

if (isMain(import.meta.url)) main();
