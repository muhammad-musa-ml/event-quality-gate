// Runtime of `eqg check-stream` on a stream of 1,000,000 synthetic events, five runs, each a fresh process.
//
// The stream is written to tmp/ (not committed). To avoid a file in which each user's events sit next to each
// other, every event goes to one of 64 buckets at random and the buckets are joined, so a user's events are
// spread across the whole file the way a stream shared by many users would be.
import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { freemem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runMeta, summarize, writeJson } from './meta.js';
import { isMain, repoRoot } from './paths.js';
import { DEFAULT_START_MS, Rng, userEvents } from './synthetic.js';

export const EVENTS = 1_000_000;
export const RUNS = 5;
const BUCKETS = 64;
const MIN_FREE_GB = 1.5;

function freeGb(): number {
  return freemem() / 2 ** 30;
}

function writeStream(path: string, scratch: string, events: number, seed: number): { users: number } {
  mkdirSync(scratch, { recursive: true });
  const rng = new Rng(seed);
  const ctx = { seed, counter: 0, startMs: DEFAULT_START_MS, spanMs: 7 * 86_400_000 };
  const parts = Array.from({ length: BUCKETS }, (_, b) => join(scratch, `part-${b}.jsonl`));
  const fds = parts.map((p) => openSync(p, 'w'));
  const buffers: string[] = parts.map(() => '');
  const flush = (b: number): void => {
    if (buffers[b]!.length > 0) writeSync(fds[b]!, buffers[b]!);
    buffers[b] = '';
  };
  let count = 0;
  let user = 0;
  while (count < events) {
    for (const e of userEvents(rng, user, ctx)) {
      if (count >= events) break;
      const b = rng.int(BUCKETS);
      buffers[b] += `${JSON.stringify(e)}\n`;
      if (buffers[b]!.length > 262_144) flush(b);
      count++;
    }
    user++;
  }
  for (let b = 0; b < BUCKETS; b++) flush(b);
  fds.forEach((fd) => closeSync(fd));
  const out = openSync(path, 'w');
  for (const p of parts) {
    writeSync(out, readFileSync(p));
    rmSync(p);
  }
  closeSync(out);
  return { users: user };
}

interface Run {
  run: number;
  wallMs: number;
  checkMs: number;
  peakRssMb: number;
  eventsPerSecond: number;
  findings: number;
  freeRamGbBefore: number;
}

function main(): void {
  const root = repoRoot();
  const scratch = join(root, 'tmp', 'bench');
  const file = join(scratch, 'events-1m.jsonl');
  if (freeGb() < MIN_FREE_GB) throw new Error(`only ${freeGb().toFixed(2)} GB of RAM is free; this run needs at least ${MIN_FREE_GB} GB, so it was not started`);
  const meta = runMeta(root);
  const started = performance.now();
  const { users } = writeStream(file, scratch, EVENTS, 7);
  const bytes = statSync(file).size;
  console.log(`wrote ${EVENTS} events for ${users} users, ${(bytes / 2 ** 20).toFixed(1)} MiB, in ${Math.round(performance.now() - started)} ms`);

  const cli = join(root, 'dist', 'src', 'cli.js');
  const plan = join(root, 'examples', 'tracking-plan.json');
  const runs: Run[] = [];
  try {
    for (let i = 1; i <= RUNS; i++) {
      const free = freeGb();
      if (free < MIN_FREE_GB) throw new Error(`only ${free.toFixed(2)} GB of RAM is free before run ${i}; stopping`);
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [cli, 'check-stream', file, '--plan', plan, '--format', 'json', '--timing'], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
      const wallMs = performance.now() - t0;
      if (r.status !== 0 && r.status !== 1) throw new Error(`run ${i}: eqg exited ${String(r.status)}: ${r.stderr}`);
      const report = JSON.parse(r.stdout) as { events: number; findingsTotal: number; timing: { elapsedMs: number; peakRssKb: number } };
      if (report.events !== EVENTS) throw new Error(`run ${i}: the tool read ${report.events} events, expected ${EVENTS}`);
      runs.push({
        run: i,
        wallMs: Math.round(wallMs),
        checkMs: report.timing.elapsedMs,
        peakRssMb: Math.round(report.timing.peakRssKb / 1024),
        eventsPerSecond: Math.round(EVENTS / (report.timing.elapsedMs / 1000)),
        findings: report.findingsTotal,
        freeRamGbBefore: Math.round(free * 100) / 100,
      });
      console.log(`run ${i}: wall ${Math.round(wallMs)} ms, check ${report.timing.elapsedMs} ms, peak ${Math.round(report.timing.peakRssKb / 1024)} MB, findings ${report.findingsTotal}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeJson(join(root, 'results', 'runtime', 'runtime.json'), {
    description: 'Runtime of eqg check-stream on 1,000,000 synthetic events. Each run is a fresh node process. Wall time includes starting node and loading the program; check time is measured inside the process around reading and checking the file.',
    command: 'node dist/scripts/bench-runtime.js',
    events: EVENTS,
    users,
    fileBytes: bytes,
    generator: 'scripts/synthetic.ts userEvents (seed 7), events spread over 64 random buckets then joined',
    plan: 'examples/tracking-plan.json',
    runs,
    summary: {
      wallMs: summarize(runs.map((r) => r.wallMs)),
      checkMs: summarize(runs.map((r) => r.checkMs)),
      peakRssMb: summarize(runs.map((r) => r.peakRssMb)),
      eventsPerSecond: summarize(runs.map((r) => r.eventsPerSecond)),
    },
    conditions: 'One laptop. Other programs were running during the runs; free RAM before each run is listed per run. No effort was made to quiet the machine.',
    meta,
  });
  console.log('wrote results/runtime/runtime.json');
}

if (isMain(import.meta.url)) main();
