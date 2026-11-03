import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { cpus, freemem, platform, release, totalmem } from 'node:os';

export interface RunMeta {
  commit: string;
  /** True when tracked files differed from the commit at the time of the run. */
  dirty: boolean;
  node: string;
  os: string;
  cpu: string;
  logicalCpus: number;
  totalRamGb: number;
  freeRamGbAtStart: number;
  startedAt: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function runMeta(root: string): RunMeta {
  const cpu = cpus();
  return {
    commit: git(['rev-parse', 'HEAD'], root),
    dirty: git(['status', '--porcelain', '--untracked-files=no'], root) !== '',
    node: process.version,
    os: `${platform()} ${release()}`,
    cpu: cpu[0]?.model.trim() ?? 'unknown',
    logicalCpus: cpu.length,
    totalRamGb: Math.round((totalmem() / 2 ** 30) * 10) / 10,
    freeRamGbAtStart: Math.round((freemem() / 2 ** 30) * 100) / 100,
    startedAt: new Date().toISOString(),
  };
}

/** Writes JSON with a trailing newline and no byte order mark. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function summarize(values: readonly number[]): { mean: number; sd: number; min: number; max: number; median: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const median = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return { mean, sd, min: sorted[0]!, max: sorted[n - 1]!, median };
}
