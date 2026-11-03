#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_STREAM_OPTIONS, checkStreamFile, parseDuration } from './check-stream.js';
import { countByType, failsGate } from './findings.js';
import { DEFAULT_TRACKERS, lintPaths } from './lint-code.js';
import { PlanError, loadPlan } from './plan.js';
import { parseSplit, readCovariates, runReadout } from './readout.js';
import { renderLintText, renderReadoutText, renderStreamText } from './report.js';
import { VERSION } from './version.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

const USAGE = `eqg ${VERSION}: checks for analytics instrumentation and experiment readouts

usage:
  eqg lint-code <path>... --plan <plan.json> [--tracker <name>]... [--allow-unverifiable] [--format text|json]
  eqg check-stream <events.jsonl | -> --plan <plan.json> [--late-tolerance 15m] [--skew-tolerance 5m]
                   [--examples 3] [--require-received-at] [--format text|json] [--timing]
  eqg readout <rows.jsonl> --split control=0.5,treatment=0.5 [--control <arm>] [--level 0.95]
              [--srm-alpha 0.001] [--covariates <pre.jsonl>] [--format text|json]
  eqg validate-plan <plan.json>

exit codes: 0 no findings, 1 findings, 2 the tool could not run (bad flags, unreadable input, invalid plan)
`;

class UsageError extends Error {}

function format(value: string | undefined): 'text' | 'json' {
  if (value === undefined || value === 'text') return 'text';
  if (value === 'json') return 'json';
  throw new UsageError(`--format must be text or json, got "${value}"`);
}

function number(name: string, value: string | undefined, fallback: number, ok: (n: number) => boolean, expect: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || !ok(n)) throw new UsageError(`${name} must be ${expect}, got "${value}"`);
  return n;
}

function parse<T extends Record<string, { type: 'string' | 'boolean'; multiple?: boolean }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function json(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function lintCode(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    plan: { type: 'string' },
    tracker: { type: 'string', multiple: true },
    'allow-unverifiable': { type: 'boolean' },
    format: { type: 'string' },
  });
  if (positionals.length === 0) throw new UsageError('lint-code needs at least one file or directory to scan');
  const fmt = format(values.format);
  const plan = loadPlan(values.plan ?? 'tracking-plan.json');
  const trackers = values.tracker && values.tracker.length > 0 ? values.tracker : [...DEFAULT_TRACKERS];
  const result = lintPaths(positionals, plan, { trackers, cwd: io.cwd });
  const allow = values['allow-unverifiable'] === true;
  const failed = failsGate(result.findings, allow);
  if (fmt === 'json') {
    json(io, {
      tool: 'eqg',
      command: 'lint-code',
      version: VERSION,
      result: failed ? 'fail' : 'pass',
      trackers,
      allowUnverifiable: allow,
      summary: {
        filesScanned: result.filesScanned,
        callsFound: result.callsFound,
        callsChecked: result.callsChecked,
        valuesNotChecked: result.valuesNotChecked,
        findings: result.findings.length,
        findingsByType: countByType(result.findings),
      },
      findings: result.findings,
    });
  } else {
    io.stdout(renderLintText(result, trackers, failed));
  }
  return failed ? 1 : 0;
}

async function checkStream(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    plan: { type: 'string' },
    'late-tolerance': { type: 'string' },
    'skew-tolerance': { type: 'string' },
    examples: { type: 'string' },
    'require-received-at': { type: 'boolean' },
    format: { type: 'string' },
    timing: { type: 'boolean' },
  });
  if (positionals.length !== 1) throw new UsageError('check-stream takes exactly one input: a JSONL file, or - for standard input');
  const fmt = format(values.format);
  const plan = loadPlan(values.plan ?? 'tracking-plan.json');
  const started = Date.now();
  const report = await checkStreamFile(positionals[0]!, plan, {
    lateToleranceMs: values['late-tolerance'] === undefined ? DEFAULT_STREAM_OPTIONS.lateToleranceMs : parseDuration(values['late-tolerance']),
    skewToleranceMs: values['skew-tolerance'] === undefined ? DEFAULT_STREAM_OPTIONS.skewToleranceMs : parseDuration(values['skew-tolerance']),
    examplesPerType: number('--examples', values.examples, DEFAULT_STREAM_OPTIONS.examplesPerType, (n) => Number.isInteger(n) && n >= 0, 'a non-negative integer'),
    requireReceivedAt: values['require-received-at'] === true,
  });
  const elapsedMs = Date.now() - started;
  const failed = report.findingsTotal > 0;
  if (fmt === 'json') {
    json(io, {
      tool: 'eqg',
      command: 'check-stream',
      version: VERSION,
      result: failed ? 'fail' : 'pass',
      input: positionals[0],
      ...report,
      ...(values.timing ? { timing: { elapsedMs, peakRssKb: process.resourceUsage().maxRSS } } : {}),
    });
  } else {
    io.stdout(renderStreamText(report, positionals[0]!, failed));
    if (values.timing) io.stdout(`timing: ${elapsedMs} ms, peak resident set ${Math.round(process.resourceUsage().maxRSS / 1024)} MB\n`);
  }
  return failed ? 1 : 0;
}

async function readout(args: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(args, {
    split: { type: 'string' },
    control: { type: 'string' },
    level: { type: 'string' },
    'srm-alpha': { type: 'string' },
    covariates: { type: 'string' },
    format: { type: 'string' },
  });
  if (positionals.length !== 1) throw new UsageError('readout takes exactly one input: a JSONL file of rows');
  if (values.split === undefined) throw new UsageError('readout needs --split, the planned share of users per arm, such as control=0.5,treatment=0.5');
  const fmt = format(values.format);
  const split = parseSplit(values.split);
  const control = values.control ?? Object.keys(split)[0]!;
  const level = number('--level', values.level, 0.95, (n) => n > 0 && n < 1, 'strictly between 0 and 1');
  const srmAlpha = number('--srm-alpha', values['srm-alpha'], 0.001, (n) => n > 0 && n < 1, 'strictly between 0 and 1');
  const covariates = values.covariates === undefined ? undefined : await readCovariates(values.covariates);
  const report = await runReadout(positionals[0]!, { split, control, level, srmAlpha, ...(covariates ? { covariates } : {}) });
  const failed = report.findings.length > 0;
  if (fmt === 'json') {
    json(io, { tool: 'eqg', command: 'readout', version: VERSION, result: failed ? 'fail' : 'pass', input: positionals[0], ...report, findingsByType: countByType(report.findings) });
  } else {
    io.stdout(renderReadoutText(report, positionals[0]!, failed));
  }
  return failed ? 1 : 0;
}

function validatePlan(args: string[], io: Io): number {
  const { positionals } = parse(args, {});
  if (positionals.length !== 1) throw new UsageError('validate-plan takes exactly one plan file');
  try {
    const plan = loadPlan(positionals[0]!);
    const events = Object.keys(plan.events).length;
    io.stdout(`ok: ${positionals[0]} declares ${events} event${events === 1 ? '' : 's'} and a funnel of ${plan.funnel.length} step${plan.funnel.length === 1 ? '' : 's'}\n`);
    return 0;
  } catch (e) {
    if (e instanceof PlanError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'lint-code':
        return await lintCode(rest, io);
      case 'check-stream':
        return await checkStream(rest, io);
      case 'readout':
        return await readout(rest, io);
      case 'validate-plan':
        return validatePlan(rest, io);
      case '--help':
      case '-h':
      case 'help':
        io.stdout(USAGE);
        return 0;
      case '--version':
      case '-v':
        io.stdout(`${VERSION}\n`);
        return 0;
      case undefined:
        io.stderr(USAGE);
        return 2;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`eqg: ${e.message}\n\n${USAGE}`);
    } else {
      io.stderr(`eqg: ${(e as Error).message}\n`);
    }
    return 2;
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const io: Io = {
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
    cwd: process.cwd(),
  };
  process.exitCode = await main(process.argv.slice(2), io);
}
