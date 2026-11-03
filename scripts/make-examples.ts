// Writes the small stream and experiment files under examples/ from fixed seeds.
//   node dist/scripts/make-examples.js          write the files
//   node dist/scripts/make-examples.js --check  fail if the committed files differ from what the seeds produce
//   node dist/scripts/make-examples.js --search-seed   print the first seed that gives the demo disagreement
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Moments2, ratioDifference, ratioInterval } from '../src/stats.js';
import { isMain, repoRoot } from './paths.js';
import { Rng, drawUser, generateCleanStream, toJsonl } from './synthetic.js';
import type { ClusterModel, StreamEvent } from './synthetic.js';

export const STREAM_SEED = 2026;
export const STREAM_USERS = 40;
/** The first seed, searching upward from 1 (`--search-seed`), for which the request-level interval excludes zero and the user-level one does not. The true effect is zero. */
export const DEMO_SEED = 1;
export const DEMO_MODEL: ClusterModel = { p0: 0.2, icc: 0.3, meanRequests: 5 };
export const DEMO_USERS_PER_ARM = 200;

interface DemoData {
  rows: string[];
  covariates: string[];
}

export function demoExperiment(seed: number, usersControl: number, usersTreatment: number, effect = 0): DemoData {
  const rng = new Rng(seed);
  const rows: string[] = [];
  const covariates: string[] = [];
  const arms: Array<[string, number, number]> = [
    ['control', usersControl, 0],
    ['treatment', usersTreatment, effect],
  ];
  for (const [arm, count, shift] of arms) {
    for (let i = 0; i < count; i++) {
      const user = `${arm === 'control' ? 'c' : 't'}_${String(i).padStart(5, '0')}`;
      const model = { ...DEMO_MODEL, p0: DEMO_MODEL.p0 + shift };
      const u = drawUser(rng, model);
      for (let r = 0; r < u.requests; r++) rows.push(JSON.stringify({ user_id: user, arm, y: rng.next() < u.p ? 1 : 0 }));
      let pre = 0;
      const preRequests = 1 + rng.poisson(DEMO_MODEL.meanRequests - 1);
      for (let r = 0; r < preRequests; r++) if (rng.next() < u.p) pre++;
      covariates.push(JSON.stringify({ user_id: user, pre }));
    }
  }
  return { rows, covariates };
}

/** Whether the request-level interval excludes zero while the user-level one does not. */
export function disagrees(rows: readonly string[]): boolean {
  const user = new Map<string, { arm: string; y: number; x: number }>();
  const byRow: Record<string, Moments2> = { control: new Moments2(), treatment: new Moments2() };
  for (const line of rows) {
    const r = JSON.parse(line) as { user_id: string; arm: string; y: number };
    byRow[r.arm]!.push(r.y, 1);
    const u = user.get(r.user_id) ?? { arm: r.arm, y: 0, x: 0 };
    u.y += r.y;
    u.x += 1;
    user.set(r.user_id, u);
  }
  const byUser: Record<string, Moments2> = { control: new Moments2(), treatment: new Moments2() };
  for (const u of user.values()) byUser[u.arm]!.push(u.y, u.x);
  const naive = ratioDifference(ratioInterval(byRow['treatment']!, 0.95), ratioInterval(byRow['control']!, 0.95), 0.95);
  const clustered = ratioDifference(ratioInterval(byUser['treatment']!, 0.95), ratioInterval(byUser['control']!, 0.95), 0.95);
  return (naive.lower > 0 || naive.upper < 0) && clustered.lower <= 0 && clustered.upper >= 0;
}

function firstIndex(events: StreamEvent[], pred: (e: StreamEvent) => boolean, from = 0): number {
  const i = events.findIndex((e, k) => k >= from && pred(e));
  if (i < 0) throw new Error('make-examples: no event matches the planting rule; change the seed or the rule');
  return i;
}

/** The clean stream with one fault of each kind planted at fixed places. */
export function faultyStream(clean: StreamEvent[]): string[] {
  const events = clean.map((e) => structuredClone(e));
  const mutate = (i: number, f: (e: StreamEvent) => void): void => f(events[i]!);

  mutate(firstIndex(events, () => true, 10), (e) => (e.name = 'signup_complete'));
  mutate(firstIndex(events, (e) => e.name === 'signup_completed', 20), (e) => delete e.properties['method']);
  mutate(firstIndex(events, (e) => e.name === 'page_created', 30), (e) => (e.properties['colour'] = 'red'));
  mutate(firstIndex(events, (e) => e.name === 'workspace_created', 40), (e) => (e.properties['seats'] = '5'));
  mutate(firstIndex(events, (e) => e.name === 'page_created', 60), (e) => (e.properties['template'] = 'poster'));
  mutate(firstIndex(events, (e) => e.name === 'signup_completed', 70), (e) => (e.properties['referrer'] = 'jane.doe@example.com'));
  mutate(firstIndex(events, (e) => e.name === 'signup_completed', 90), (e) => (e.properties['referrer'] = '(555) 010-0199'));
  mutate(firstIndex(events, (e) => e.name === 'onboarding_step_completed', 100), (e) => (e.received_at = e.ts + 3 * 3_600_000));
  mutate(firstIndex(events, (e) => e.name === 'onboarding_step_completed', 120), (e) => (e.ts = e.received_at + 3_600_000));

  const ws = events.findIndex((e) => e.name === 'workspace_created' && events.some((s) => s.name === 'signup_completed' && s.user_id === e.user_id));
  const signup = events.find((s) => s.name === 'signup_completed' && s.user_id === events[ws]!.user_id)!;
  mutate(ws, (e) => {
    e.ts = signup.ts - 60_000;
    e.received_at = e.ts + 1000;
  });

  const lines = events.map((e) => JSON.stringify(e));
  for (let k = 0; k < 45; k++) {
    lines.push(
      JSON.stringify({
        event_id: `evt_extra_${k}`,
        name: 'signup_completed',
        user_id: `usr_extra_${String(k).padStart(3, '0')}`,
        ts: clean[0]!.ts + k * 1000,
        received_at: clean[0]!.ts + k * 1000 + 800,
        properties: { method: 'email', referrer: `utm_${k}` },
      }),
    );
  }
  lines.splice(200, 0, lines[150]!);
  lines[240] = lines[240]!.slice(0, 60);
  const bad = JSON.parse(lines[260]!) as Record<string, unknown>;
  delete bad['user_id'];
  lines[260] = JSON.stringify(bad);
  return lines;
}

export function buildExamples(): Map<string, string> {
  const files = new Map<string, string>();
  const clean = generateCleanStream({ users: STREAM_USERS, seed: STREAM_SEED });
  files.set('examples/streams/clean.jsonl', toJsonl(clean));
  files.set('examples/streams/faulty.jsonl', faultyStream(clean).join('\n') + '\n');
  const demo = demoExperiment(DEMO_SEED, DEMO_USERS_PER_ARM, DEMO_USERS_PER_ARM);
  files.set('examples/experiment/clean.jsonl', demo.rows.join('\n') + '\n');
  files.set('examples/experiment/pre-period.jsonl', demo.covariates.join('\n') + '\n');
  const skewed = demoExperiment(DEMO_SEED + 1000, 240, 160);
  files.set('examples/experiment/srm.jsonl', skewed.rows.join('\n') + '\n');
  return files;
}

function main(): number {
  const root = repoRoot();
  const arg = process.argv[2];
  if (arg === '--search-seed') {
    for (let seed = 1; seed <= 500; seed++) {
      if (disagrees(demoExperiment(seed, DEMO_USERS_PER_ARM, DEMO_USERS_PER_ARM).rows)) {
        console.log(`first seed with the disagreement: ${seed}`);
        return 0;
      }
    }
    console.log('no seed in 1..500 gives the disagreement');
    return 1;
  }
  let stale = 0;
  for (const [rel, text] of buildExamples()) {
    const full = join(root, rel);
    if (arg === '--check') {
      if (!existsSync(full) || readFileSync(full, 'utf8') !== text) {
        console.log(`differs from the generator: ${rel}`);
        stale++;
      }
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
      console.log(`wrote ${rel} (${text.length} bytes)`);
    }
  }
  return stale > 0 ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
