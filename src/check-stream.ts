import { accessSync, constants, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { FindingType } from './findings.js';
import { detectPii } from './pii.js';
import { getEvent, getProperty, matchesType } from './plan.js';
import type { PropertySpec, TrackingPlan } from './plan.js';

export interface StreamOptions {
  /** An event is late when received_at - ts is greater than this many milliseconds. */
  lateToleranceMs: number;
  /** An event is from the future when ts - received_at is greater than this many milliseconds. */
  skewToleranceMs: number;
  /** How many examples to keep for each finding type. Counts are always complete. */
  examplesPerType: number;
  /** Treat an event without received_at as an envelope problem instead of skipping the late and skew checks for it. */
  requireReceivedAt: boolean;
}

export const DEFAULT_STREAM_OPTIONS: StreamOptions = {
  lateToleranceMs: 15 * 60_000,
  skewToleranceMs: 5 * 60_000,
  examplesPerType: 3,
  requireReceivedAt: false,
};

export interface StreamExample {
  line: number;
  message: string;
  eventId?: string;
  event?: string;
  user?: string;
  property?: string;
}

export interface StreamReport {
  lines: number;
  /** Non-blank lines. */
  events: number;
  /** Lines with a parsable JSON object and a well-formed envelope. */
  valid: number;
  duplicates: number;
  users: number;
  lateChecked: number;
  skewChecked: number;
  missingReceivedAt: number;
  options: StreamOptions;
  findingsTotal: number;
  counts: Record<string, number>;
  examples: Record<string, StreamExample[]>;
}

const MAX_LINE_CHARS = 1_048_576;
/** The largest time a JavaScript Date can hold. */
const MAX_TIME_MS = 8.64e15;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90s", "5m", "2h", "1d", "1500ms"; a bare number is milliseconds. */
export function parseDuration(text: string): number {
  const m = DURATION.exec(text.trim());
  if (!m) throw new Error(`invalid duration "${text}": use a number with ms, s, m, h or d, such as 90s or 15m`);
  return Number(m[1]) * UNIT_MS[m[2] ?? 'ms']!;
}

function parseTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= MAX_TIME_MS ? v : null;
  if (typeof v === 'string' && ISO_8601.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function describeJson(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'string') return `string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)}`;
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number' && !Number.isInteger(v)) return `non-integer number ${String(v)}`;
  return `${typeof v} ${String(v)}`;
}

interface FunnelState {
  ts: Float64Array;
  line: Int32Array;
}

export class StreamChecker {
  private readonly options: StreamOptions;
  private readonly counts: Record<string, number> = {};
  private readonly examples: Record<string, StreamExample[]> = {};
  private readonly seen = new Set<string>();
  private readonly users = new Set<string>();
  private readonly funnelIndex = new Map<string, number>();
  private readonly funnelState = new Map<string, FunnelState>();
  private readonly distinct = new Map<string, { values: Set<string>; flagged: boolean }>();
  private lines = 0;
  private events = 0;
  private valid = 0;
  private duplicates = 0;
  private lateChecked = 0;
  private skewChecked = 0;
  private missingReceivedAt = 0;
  private findingsTotal = 0;
  private finished: StreamReport | undefined;

  constructor(
    private readonly plan: TrackingPlan,
    options: Partial<StreamOptions> = {},
  ) {
    this.options = { ...DEFAULT_STREAM_OPTIONS, ...options };
    plan.funnel.forEach((name, i) => this.funnelIndex.set(name, i));
  }

  private add(type: FindingType, example: StreamExample): void {
    this.findingsTotal++;
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    const list = this.examples[type];
    if (list === undefined) {
      if (this.options.examplesPerType > 0) this.examples[type] = [example];
    } else if (list.length < this.options.examplesPerType) {
      list.push(example);
    }
  }

  addLine(raw: string): void {
    this.lines++;
    const lineNo = this.lines;
    const text = lineNo === 1 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (text.trim() === '') return;
    this.events++;
    if (text.length > MAX_LINE_CHARS) {
      this.add('invalid-json', { line: lineNo, message: `line is longer than ${MAX_LINE_CHARS} characters and was not parsed` });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      this.add('invalid-json', { line: lineNo, message: (e as Error).message });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.add('invalid-envelope', { line: lineNo, message: 'the line is valid JSON but not an object' });
      return;
    }
    this.checkEvent(lineNo, parsed as Record<string, unknown>);
  }

  private checkEvent(lineNo: number, obj: Record<string, unknown>): void {
    const problems: string[] = [];
    const eventId = obj['event_id'];
    const name = obj['name'];
    const user = obj['user_id'];
    if (typeof eventId !== 'string' || eventId === '') problems.push('event_id must be a non-empty string');
    if (typeof name !== 'string' || name === '') problems.push('name must be a non-empty string');
    if (typeof user !== 'string' || user === '') problems.push('user_id must be a non-empty string');
    const ts = parseTime(obj['ts']);
    if (ts === null) problems.push('ts must be epoch milliseconds or an ISO 8601 string with an offset');
    let receivedAt: number | null = null;
    if (obj['received_at'] === undefined) {
      if (this.options.requireReceivedAt) problems.push('received_at is required');
    } else {
      receivedAt = parseTime(obj['received_at']);
      if (receivedAt === null) problems.push('received_at must be epoch milliseconds or an ISO 8601 string with an offset');
    }
    const rawProps = obj['properties'];
    if (rawProps !== undefined && (typeof rawProps !== 'object' || rawProps === null || Array.isArray(rawProps))) {
      problems.push('properties must be an object');
    }
    if (problems.length > 0) {
      this.add('invalid-envelope', { line: lineNo, message: problems.join('; ') });
      return;
    }
    this.valid++;
    const id = eventId as string;
    const event = name as string;
    const userId = user as string;
    const when = ts as number;
    const where: StreamExample = { line: lineNo, message: '', eventId: id, event, user: userId };

    if (this.seen.has(id)) {
      this.duplicates++;
      this.add('duplicate-event-id', { ...where, message: `event_id "${id}" was already seen; this copy is skipped by the other checks` });
      return;
    }
    this.seen.add(id);
    this.users.add(userId);

    if (obj['received_at'] === undefined) {
      this.missingReceivedAt++;
    } else {
      const delta = (receivedAt as number) - when;
      this.lateChecked++;
      this.skewChecked++;
      if (delta > this.options.lateToleranceMs) {
        this.add('late-event', { ...where, message: `received ${delta} ms after it happened, more than the ${this.options.lateToleranceMs} ms tolerance` });
      } else if (-delta > this.options.skewToleranceMs) {
        this.add('clock-skew', { ...where, message: `timestamp is ${-delta} ms ahead of the receive time, more than the ${this.options.skewToleranceMs} ms tolerance` });
      }
    }

    const spec = getEvent(this.plan, event);
    if (!spec) {
      this.add('unknown-event', { ...where, message: `event "${event}" is not in the plan` });
      return;
    }

    const props = (rawProps ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(props)) {
      const value = props[key];
      const ps = getProperty(spec, key);
      const at = { ...where, property: key };
      if (!ps) {
        this.add('unexpected-property', { ...at, message: `property "${key}" is not declared for "${event}"` });
      } else {
        this.checkValue(at, ps, event, key, value);
      }
      if (typeof value === 'string' && ps?.pii !== true) {
        const shape = detectPii(value);
        if (shape) this.add('pii-shaped-value', { ...at, message: `property "${key}" holds a value that looks like ${shape === 'email' ? 'an email address' : 'a phone number'}, and the plan does not declare it pii` });
      }
    }
    for (const req of spec.required) {
      if (!Object.hasOwn(props, req)) this.add('missing-required-property', { ...where, property: req, message: `"${event}" is missing required property "${req}"` });
    }

    const step = this.funnelIndex.get(event);
    if (step !== undefined) {
      let state = this.funnelState.get(userId);
      if (!state) {
        state = { ts: new Float64Array(this.plan.funnel.length).fill(Number.NaN), line: new Int32Array(this.plan.funnel.length) };
        this.funnelState.set(userId, state);
      }
      const current = state.ts[step]!;
      if (Number.isNaN(current) || when < current) {
        state.ts[step] = when;
        state.line[step] = lineNo;
      }
    }
  }

  private checkValue(at: StreamExample, ps: PropertySpec, event: string, key: string, value: unknown): void {
    if (!matchesType(ps.type, value)) {
      this.add('type-mismatch', { ...at, message: `property "${key}" of "${event}" expects ${ps.type} but got ${describeJson(value)}` });
      return;
    }
    if (ps.enum && !ps.enum.includes(value as string | number | boolean)) {
      this.add('enum-violation', { ...at, message: `property "${key}" of "${event}" is ${JSON.stringify(value)}, which is not in the plan's enum` });
      return;
    }
    if (ps.maxDistinct !== undefined) {
      const mapKey = `${event}\u0000${key}`;
      let entry = this.distinct.get(mapKey);
      if (!entry) {
        entry = { values: new Set(), flagged: false };
        this.distinct.set(mapKey, entry);
      }
      if (entry.flagged) return;
      entry.values.add(JSON.stringify(value));
      if (entry.values.size > ps.maxDistinct) {
        entry.flagged = true;
        entry.values.clear();
        this.add('high-cardinality', { ...at, message: `property "${key}" of "${event}" has more than ${ps.maxDistinct} distinct values (the plan's bound); this is the line where the bound was passed` });
      }
    }
  }

  finish(): StreamReport {
    if (this.finished) return this.finished;
    const funnel = this.plan.funnel;
    for (const [user, state] of this.funnelState) {
      let reported = false;
      for (let i = 0; i < funnel.length && !reported; i++) {
        for (let j = i + 1; j < funnel.length && !reported; j++) {
          const ti = state.ts[i]!;
          const tj = state.ts[j]!;
          if (!Number.isNaN(ti) && !Number.isNaN(tj) && tj < ti) {
            reported = true;
            this.add('funnel-out-of-order', {
              line: state.line[j]!,
              user,
              event: funnel[j]!,
              message: `first "${funnel[j]}" (${new Date(tj).toISOString()}) is earlier than first "${funnel[i]}" (${new Date(ti).toISOString()}); the plan's funnel puts "${funnel[i]}" first`,
            });
          }
        }
      }
    }
    if (this.events === 0) {
      this.add('no-events', { line: 0, message: 'the stream held no events, so nothing was checked' });
    }
    this.finished = {
      lines: this.lines,
      events: this.events,
      valid: this.valid,
      duplicates: this.duplicates,
      users: this.users.size,
      lateChecked: this.lateChecked,
      skewChecked: this.skewChecked,
      missingReceivedAt: this.missingReceivedAt,
      options: this.options,
      findingsTotal: this.findingsTotal,
      counts: Object.fromEntries(Object.entries(this.counts).sort(([a], [b]) => a.localeCompare(b))),
      examples: this.examples,
    };
    return this.finished;
  }
}

export function checkLines(lines: Iterable<string>, plan: TrackingPlan, options: Partial<StreamOptions> = {}): StreamReport {
  const checker = new StreamChecker(plan, options);
  for (const l of lines) checker.addLine(l);
  return checker.finish();
}

/** Reads a JSONL file, or standard input when the path is "-", one line at a time. */
export async function checkStreamFile(path: string, plan: TrackingPlan, options: Partial<StreamOptions> = {}): Promise<StreamReport> {
  if (path !== '-') {
    try {
      accessSync(path, constants.R_OK);
    } catch (e) {
      throw new Error(`cannot read ${path}: ${(e as Error).message}`, { cause: e });
    }
  }
  const input = path === '-' ? process.stdin : createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const checker = new StreamChecker(plan, options);
  try {
    for await (const line of rl) checker.addLine(line);
  } catch (e) {
    throw new Error(`cannot read ${path}: ${(e as Error).message}`, { cause: e });
  }
  return checker.finish();
}
