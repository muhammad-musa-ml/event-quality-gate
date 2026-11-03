// Fault injection. From a clean synthetic stream and a clean synthetic code corpus, inject N faults of each
// kind, run the checkers, and count how many injected faults are reported at the place they were injected.
// Families whose faults the tool cannot see by construction are included on purpose: their rate is the
// measurement, and the README states why they are missed.
import { join } from 'node:path';
import { checkLines } from '../src/check-stream.js';
import type { StreamReport } from '../src/check-stream.js';
import { UNVERIFIABLE_TYPES } from '../src/findings.js';
import type { Finding, FindingType } from '../src/findings.js';
import { lintSource } from '../src/lint-code.js';
import { loadPlan } from '../src/plan.js';
import { DEFAULT_STREAM_OPTIONS } from '../src/check-stream.js';
import { buildCorpus, quoted, randomCall, TEMPLATES } from './code-corpus.js';
import type { CallSite, PropSite } from './code-corpus.js';
import { runMeta, summarize, writeJson } from './meta.js';
import { isMain, repoRoot } from './paths.js';
import { Rng, generateCleanStream, userEvents } from './synthetic.js';
import type { StreamEvent } from './synthetic.js';

export const SEEDS = [201, 202, 203, 204, 205];
export const FAULTS_PER_FAMILY = 200;
export const STREAM_USERS = 3000;
export const CARDINALITY_TRIALS = 50;
const ALL = Number.MAX_SAFE_INTEGER;

export type Expectation = 'detected' | 'flagged as unverifiable' | 'missed by design';

export interface Fault {
  /** 1-based line of the injected fault. */
  line?: number;
  /** For findings keyed by user rather than by line. */
  user?: string;
  expect: FindingType;
}

export interface StreamFamily {
  id: string;
  description: string;
  expectation: Expectation;
  note: string;
  run(events: StreamEvent[], rng: Rng, n: number): { lines: string[]; faults: Fault[] };
}

function pick<T>(items: T[], n: number, rng: Rng): T[] {
  const copy = [...items];
  rng.shuffle(copy);
  return copy.slice(0, n);
}

/** Mutates n events chosen from the candidates in place and keeps the line numbers. */
function inPlace(
  events: StreamEvent[],
  rng: Rng,
  n: number,
  candidate: (e: StreamEvent) => boolean,
  expect: FindingType,
  mutate: (e: StreamEvent, k: number, rng: Rng) => void,
): { lines: string[]; faults: Fault[] } {
  const indices = pick(
    events.flatMap((e, i) => (candidate(e) ? [i] : [])),
    n,
    rng,
  );
  indices.forEach((i, k) => mutate(events[i]!, k, rng));
  const faults = indices.map((i) => ({ line: i + 1, expect }));
  return { lines: events.map((e) => JSON.stringify(e)), faults };
}

const INT_PROPS = ['seats', 'block_count', 'invitee_count'];
const BOOL_PROPS = ['skipped', 'bulk'];
const ENUM_PROPS: Record<string, string[]> = {
  method: ['email', 'google', 'sso'],
  plan_tier: ['free', 'plus', 'business'],
  template: ['blank', 'meeting_notes', 'project_plan', 'wiki'],
  source: ['sidebar', 'shortcut', 'onboarding'],
  role: ['member', 'guest'],
  step: ['profile', 'import', 'first_page', 'invite'],
};
const hasAny = (e: StreamEvent, keys: string[]) => keys.some((k) => Object.hasOwn(e.properties, k));
const firstKey = (e: StreamEvent, keys: string[]) => keys.find((k) => Object.hasOwn(e.properties, k))!;
const enumKey = (e: StreamEvent) => Object.keys(ENUM_PROPS).find((k) => Object.hasOwn(e.properties, k))!;
const hasEnum = (e: StreamEvent) => Object.keys(ENUM_PROPS).some((k) => Object.hasOwn(e.properties, k));

function piiFamily(id: string, description: string, expectation: Expectation, note: string, make: (k: number) => string): StreamFamily {
  return {
    id,
    description,
    expectation,
    note,
    run: (events, rng, n) =>
      inPlace(events, rng, n, (e) => Object.hasOwn(e.properties, 'workspace_id'), 'pii-shaped-value', (e, k) => {
        e.properties['workspace_id'] = make(k);
      }),
  };
}

const lastGroup = (k: number) => `0${100 + (k % 900)}`;

export const STREAM_FAMILIES: StreamFamily[] = [
  {
    id: 'unknown-event',
    description: 'event name misspelled (last character dropped)',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => inPlace(events, rng, n, () => true, 'unknown-event', (e) => (e.name = e.name.slice(0, -1))),
  },
  {
    id: 'missing-required-property',
    description: 'a required property removed',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, () => true, 'missing-required-property', (e, _k, r) => {
        const required: Record<string, string[]> = {
          signup_completed: ['method'],
          workspace_created: ['workspace_id', 'plan_tier'],
          page_created: ['workspace_id', 'template'],
          invite_sent: ['workspace_id', 'invitee_count', 'role'],
          onboarding_step_completed: ['step', 'skipped'],
        };
        delete e.properties[r.pick(required[e.name]!)];
      }),
  },
  {
    id: 'unexpected-property',
    description: 'a property that is not in the plan added',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => inPlace(events, rng, n, () => true, 'unexpected-property', (e, k) => (e.properties[`extra_${k}`] = 1)),
  },
  {
    id: 'type-integer-as-string',
    description: 'an integer property sent as a string',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, (e) => hasAny(e, INT_PROPS), 'type-mismatch', (e) => {
        const key = firstKey(e, INT_PROPS);
        e.properties[key] = String(e.properties[key]);
      }),
  },
  {
    id: 'type-fractional-integer',
    description: 'an integer property sent with a fraction',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, (e) => hasAny(e, INT_PROPS), 'type-mismatch', (e) => {
        const key = firstKey(e, INT_PROPS);
        e.properties[key] = (e.properties[key] as number) + 0.5;
      }),
  },
  {
    id: 'type-boolean-as-string',
    description: 'a boolean property sent as the string "true" or "false"',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, (e) => hasAny(e, BOOL_PROPS), 'type-mismatch', (e) => {
        const key = firstKey(e, BOOL_PROPS);
        e.properties[key] = String(e.properties[key]);
      }),
  },
  {
    id: 'enum-unlisted-value',
    description: 'an enum property set to a value that is not listed',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, hasEnum, 'enum-violation', (e) => {
        const key = enumKey(e);
        e.properties[key] = `${String(e.properties[key])}_x`;
      }),
  },
  {
    id: 'enum-case-changed',
    description: 'an enum value with its first letter capitalised',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, hasEnum, 'enum-violation', (e) => {
        const key = enumKey(e);
        const v = String(e.properties[key]);
        e.properties[key] = v[0]!.toUpperCase() + v.slice(1);
      }),
  },
  {
    id: 'enum-wrong-but-valid-value',
    description: 'an enum property swapped for a different listed value',
    expectation: 'missed by design',
    note: 'Both values are allowed by the plan, so a plan cannot call either wrong.',
    run: (events, rng, n) =>
      inPlace(events, rng, n, hasEnum, 'enum-violation', (e, _k, r) => {
        const key = enumKey(e);
        e.properties[key] = r.pick(ENUM_PROPS[key]!.filter((v) => v !== e.properties[key]));
      }),
  },
  {
    id: 'duplicate-delivery',
    description: 'an event delivered twice with the same event_id',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => {
      const picked = new Set(pick(events.map((_, i) => i), n, rng));
      const lines: string[] = [];
      const faults: Fault[] = [];
      events.forEach((e, i) => {
        lines.push(JSON.stringify(e));
        if (picked.has(i)) {
          lines.push(JSON.stringify(e));
          faults.push({ line: lines.length, expect: 'duplicate-event-id' });
        }
      });
      return { lines, faults };
    },
  },
  {
    id: 'duplicate-with-new-id',
    description: 'an event retried with a new event_id and everything else the same',
    expectation: 'missed by design',
    note: 'Only the event_id is compared; the same content under a new id is a different event as far as the tool can tell.',
    run: (events, rng, n) => {
      const picked = new Set(pick(events.map((_, i) => i), n, rng));
      const lines: string[] = [];
      const faults: Fault[] = [];
      events.forEach((e, i) => {
        lines.push(JSON.stringify(e));
        if (picked.has(i)) {
          lines.push(JSON.stringify({ ...e, event_id: `${e.event_id}_retry` }));
          faults.push({ line: lines.length, expect: 'duplicate-event-id' });
        }
      });
      return { lines, faults };
    },
  },
  {
    id: 'funnel-reordered',
    description: 'a user\'s first workspace_created moved before their signup_completed',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => {
      const signup = new Map<string, StreamEvent>();
      for (const e of events) if (e.name === 'signup_completed') signup.set(e.user_id, e);
      const candidates = events.flatMap((e, i) => (e.name === 'workspace_created' && signup.has(e.user_id) ? [i] : []));
      const picked = pick(candidates, n, rng);
      const faults: Fault[] = [];
      for (const i of picked) {
        const e = events[i]!;
        const delay = e.received_at - e.ts;
        e.ts = signup.get(e.user_id)!.ts - rng.range(60_000, 3_600_000);
        e.received_at = e.ts + delay;
        faults.push({ user: e.user_id, expect: 'funnel-out-of-order' });
      }
      return { lines: events.map((e) => JSON.stringify(e)), faults };
    },
  },
  {
    id: 'funnel-step-lost',
    description: 'a user\'s signup_completed event removed, leaving later steps',
    expectation: 'missed by design',
    note: 'A stream can start in the middle of a funnel, so a missing earlier step is not reported; only steps seen out of order are.',
    run: (events, rng, n) => {
      const withWorkspace = new Set(events.filter((e) => e.name === 'workspace_created').map((e) => e.user_id));
      const candidates = events.flatMap((e, i) => (e.name === 'signup_completed' && withWorkspace.has(e.user_id) ? [i] : []));
      const dropped = new Set(pick(candidates, n, rng));
      const faults: Fault[] = [...dropped].map((i) => ({ user: events[i]!.user_id, expect: 'funnel-out-of-order' as const }));
      return { lines: events.filter((_, i) => !dropped.has(i)).map((e) => JSON.stringify(e)), faults };
    },
  },
  {
    id: 'late-arrival',
    description: 'received_at later than the 15 minute tolerance (16 minutes to 6 hours)',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, () => true, 'late-event', (e, _k, r) => {
        e.received_at = e.ts + DEFAULT_STREAM_OPTIONS.lateToleranceMs + r.range(60_000, 6 * 3_600_000);
      }),
  },
  {
    id: 'clock-ahead',
    description: 'a timestamp later than receive time by more than the 5 minute tolerance (6 minutes to 2 hours)',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, (e) => e.name === 'onboarding_step_completed', 'clock-skew', (e, _k, r) => {
        e.ts = e.received_at + DEFAULT_STREAM_OPTIONS.skewToleranceMs + r.range(60_000, 2 * 3_600_000);
      }),
  },
  piiFamily('pii-email', 'an email address in an undeclared string property', 'detected', '', (k) => `jane.doe${k}@example.com`),
  piiFamily('pii-phone-parentheses', 'a phone number written (555) 010-0xxx', 'detected', '', (k) => `(555) 010-${lastGroup(k)}`),
  piiFamily('pii-phone-dashes', 'a phone number written 555-010-0xxx', 'detected', '', (k) => `555-010-${lastGroup(k)}`),
  piiFamily('pii-phone-international', 'a phone number written +44 20 7946 0xxx', 'detected', '', (k) => `+44 20 7946 ${lastGroup(k)}`),
  piiFamily('pii-phone-digits-only', 'a phone number as ten bare digits', 'missed by design', 'Ten bare digits look like any numeric id, so the detector does not match them.', (k) => `5550100${lastGroup(k).slice(1)}`),
  piiFamily('pii-email-spelled-out', 'an email address written "name dot x at example dot com"', 'missed by design', 'Only the usual local-part@domain shape is matched.', (k) => `jane dot doe${k} at example dot com`),
  piiFamily('pii-person-name', 'a person\'s name', 'missed by design', 'A name has no fixed shape; the detector matches shapes, not meaning.', (k) => `${['Jane Doe', 'John Smith', 'Maria Garcia', 'Wei Zhang'][k % 4]!} ${k}`),
  piiFamily('pii-street-address', 'a street address', 'missed by design', 'Same reason as names: no fixed shape.', (k) => `${12 + k} Main Street, Springfield`),
  {
    id: 'truncated-line',
    description: 'a line cut off in the middle (invalid JSON)',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => {
      const lines = events.map((e) => JSON.stringify(e));
      const picked = pick(lines.map((_, i) => i), n, rng);
      for (const i of picked) lines[i] = lines[i]!.slice(0, Math.floor(lines[i]!.length / 2));
      return { lines, faults: picked.map((i) => ({ line: i + 1, expect: 'invalid-json' as const })) };
    },
  },
  {
    id: 'missing-user-id',
    description: 'user_id missing from the envelope',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) => {
      const lines = events.map((e) => JSON.stringify(e));
      const picked = pick(lines.map((_, i) => i), n, rng);
      for (const i of picked) {
        const o = JSON.parse(lines[i]!) as Record<string, unknown>;
        delete o['user_id'];
        lines[i] = JSON.stringify(o);
      }
      return { lines, faults: picked.map((i) => ({ line: i + 1, expect: 'invalid-envelope' as const })) };
    },
  },
  {
    id: 'timestamp-not-iso',
    description: 'ts written "2026-11-02 10:00:00" (no T, no offset)',
    expectation: 'detected',
    note: '',
    run: (events, rng, n) =>
      inPlace(events, rng, n, () => true, 'invalid-envelope', (e) => {
        (e as unknown as { ts: unknown }).ts = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
      }),
  },
];

interface FamilyOutcome {
  seed: number;
  injected: number;
  detected: number;
  /** Findings that do not match any injected fault. */
  stray: number;
}

function key(type: string, f: { line?: number | undefined; user?: string | undefined }): string {
  return f.user !== undefined ? `${type}#${f.user}` : `${type}@${f.line}`;
}

export function scoreStream(report: StreamReport, faults: Fault[]): { detected: number; stray: number } {
  const expected = new Set(faults.map((f) => key(f.expect, f)));
  let detected = 0;
  for (const f of faults) {
    const list = report.examples[f.expect] ?? [];
    const hit = f.user !== undefined ? list.some((x) => x.user === f.user) : list.some((x) => x.line === f.line);
    if (hit) detected++;
  }
  let stray = 0;
  for (const [type, list] of Object.entries(report.examples)) {
    for (const x of list) {
      const k = type === 'funnel-out-of-order' ? key(type, { user: x.user }) : key(type, { line: x.line });
      if (!expected.has(k)) stray++;
    }
  }
  return { detected, stray };
}

function cardinalityTrial(plan: ReturnType<typeof loadPlan>, seed: number, inject: boolean): { flagged: boolean; findings: number } {
  const rng = new Rng(seed);
  const ctx = { seed, counter: 0, startMs: Date.UTC(2026, 9, 1), spanMs: 7 * 86_400_000 };
  const events: StreamEvent[] = [];
  for (let i = 0; i < 600; i++) events.push(...userEvents(rng, i, ctx));
  if (inject) {
    const signups = events.filter((e) => e.name === 'signup_completed');
    pick(signups, 80, rng).forEach((e, k) => (e.properties['referrer'] = `utm_${seed}_${k}`));
  }
  const report = checkLines(events.map((e) => JSON.stringify(e)), plan, { examplesPerType: ALL });
  return { flagged: (report.counts['high-cardinality'] ?? 0) > 0, findings: report.findingsTotal };
}

type Outcome = 'exact' | 'unverifiable' | 'missed';

export interface CodeFamily {
  id: string;
  description: string;
  expectation: Expectation;
  note: string;
  ideal: FindingType;
  /** Where the ideal finding belongs: the call line, or the line of a property. */
  where: 'call' | 'prop';
  make(rng: Rng): { site: CallSite; prop?: string };
}

function find(rng: Rng, accept: (s: CallSite) => boolean, event?: string): CallSite {
  for (let i = 0; i < 10_000; i++) {
    const s = event === undefined ? randomCall(rng) : randomCall(rng, event);
    if (accept(s)) return s;
  }
  throw new Error('fault-injection: no call satisfies the rule');
}

const typo = (event: string, rng: Rng) => {
  const at = rng.range(2, event.length - 2);
  return event.slice(0, at) + event.slice(at + 1);
};
const required = (event: string) => TEMPLATES[event]!.filter((t) => t.required).map((t) => t.key);
const literalOf = (s: CallSite, kind: PropSite['kind']) => s.props.find((p) => p.kind === kind && /^[\d.]+$|^true$|^false$/.test(p.value));

function removeRequired(s: CallSite, rng: Rng): void {
  const key = rng.pick(required(s.event));
  s.props = s.props.filter((p) => p.key !== key);
}

const strVal = (text: string): PropSite['value'] => text;

export const CODE_FAMILIES: CodeFamily[] = [
  {
    id: 'unknown-event',
    description: 'event name misspelled (one character dropped)',
    expectation: 'detected',
    note: '',
    ideal: 'unknown-event',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.event = typo(site.event, rng);
      return { site };
    },
  },
  {
    id: 'missing-required-property',
    description: 'a required property left out of an object literal',
    expectation: 'detected',
    note: '',
    ideal: 'missing-required-property',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      removeRequired(site, rng);
      return { site };
    },
  },
  {
    id: 'unexpected-property',
    description: 'a property that is not in the plan added',
    expectation: 'detected',
    note: '',
    ideal: 'unexpected-property',
    where: 'prop',
    make: (rng) => {
      const site = randomCall(rng);
      const key = `extra_${rng.int(1000)}`;
      site.props.splice(rng.int(site.props.length + 1), 0, { key, value: '1', kind: 'int' });
      return { site, prop: key };
    },
  },
  {
    id: 'type-integer-as-string',
    description: 'an integer literal written as a string',
    expectation: 'detected',
    note: '',
    ideal: 'type-mismatch',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => literalOf(s, 'int') !== undefined);
      const p = literalOf(site, 'int')!;
      p.value = strVal(quoted(p.value, '"'));
      p.kind = 'expr';
      return { site, prop: p.key };
    },
  },
  {
    id: 'type-fractional-integer',
    description: 'an integer literal written with a fraction',
    expectation: 'detected',
    note: '',
    ideal: 'type-mismatch',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => literalOf(s, 'int') !== undefined);
      const p = literalOf(site, 'int')!;
      p.value = `${p.value}.5`;
      return { site, prop: p.key };
    },
  },
  {
    id: 'type-boolean-as-string',
    description: 'a boolean literal written as a string',
    expectation: 'detected',
    note: '',
    ideal: 'type-mismatch',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => literalOf(s, 'bool') !== undefined);
      const p = literalOf(site, 'bool')!;
      p.value = quoted(p.value, "'");
      p.kind = 'expr';
      return { site, prop: p.key };
    },
  },
  {
    id: 'enum-unlisted-value',
    description: 'an enum property set to a value that is not listed',
    expectation: 'detected',
    note: '',
    ideal: 'enum-violation',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => s.props.some((p) => p.kind === 'enum'));
      const p = site.props.find((q) => q.kind === 'enum')!;
      p.value = `${p.value}_x`;
      return { site, prop: p.key };
    },
  },
  {
    id: 'enum-case-changed',
    description: 'an enum value with its first letter capitalised',
    expectation: 'detected',
    note: '',
    ideal: 'enum-violation',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => s.props.some((p) => p.kind === 'enum'));
      const p = site.props.find((q) => q.kind === 'enum')!;
      p.value = p.value[0]!.toUpperCase() + p.value.slice(1);
      return { site, prop: p.key };
    },
  },
  {
    id: 'enum-wrong-but-valid-value',
    description: 'an enum property swapped for a different listed value',
    expectation: 'missed by design',
    note: 'Both values are allowed by the plan, so a plan cannot call either wrong.',
    ideal: 'enum-violation',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => s.props.some((p) => p.kind === 'enum'));
      const p = site.props.find((q) => q.kind === 'enum')!;
      const values = TEMPLATES[site.event]!.find((t) => t.key === p.key)!.values!;
      p.value = rng.pick(values.filter((v) => v !== p.value));
      return { site, prop: p.key };
    },
  },
  {
    id: 'pii-email-literal',
    description: 'an email address literal in an undeclared string property',
    expectation: 'detected',
    note: '',
    ideal: 'pii-shaped-value',
    where: 'prop',
    make: (rng) => piiSite(rng, `'jane.doe${rng.int(1000)}@example.com'`),
  },
  {
    id: 'pii-phone-literal',
    description: 'a phone number literal (555) 010-0xxx',
    expectation: 'detected',
    note: '',
    ideal: 'pii-shaped-value',
    where: 'prop',
    make: (rng) => piiSite(rng, `'(555) 010-0${100 + rng.int(900)}'`),
  },
  {
    id: 'pii-digits-only-literal',
    description: 'a phone number literal as ten bare digits',
    expectation: 'missed by design',
    note: 'Ten bare digits look like any numeric id, so the detector does not match them.',
    ideal: 'pii-shaped-value',
    where: 'prop',
    make: (rng) => piiSite(rng, `'5550100${100 + rng.int(900)}'`),
  },
  {
    id: 'event-name-not-literal',
    description: 'the event name passed in a variable',
    expectation: 'detected',
    note: 'Reported as non-literal-event-name: the tool says it cannot check the call, and the run fails.',
    ideal: 'non-literal-event-name',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.eventExpr = rng.pick(['eventName', 'EVENTS.signup', 'name']);
      return { site };
    },
  },
  {
    id: 'event-name-in-constant-with-typo',
    description: 'a misspelled event name held in a const declared above the call',
    expectation: 'flagged as unverifiable',
    note: 'The tool reads only literals in the call, so it reports the call as unverifiable instead of naming the typo.',
    ideal: 'unknown-event',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.preamble = [`const EVT = '${typo(site.event, rng)}';`];
      site.eventExpr = 'EVT';
      return { site };
    },
  },
  {
    id: 'properties-in-variable',
    description: 'a required property missing from an object passed by variable',
    expectation: 'flagged as unverifiable',
    note: 'The properties are not an object literal, so the tool says it cannot read them.',
    ideal: 'missing-required-property',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      removeRequired(site, rng);
      site.propsExpr = 'props';
      return { site };
    },
  },
  {
    id: 'spread-hides-missing-property',
    description: 'a required property missing, with a spread in the object literal',
    expectation: 'flagged as unverifiable',
    note: 'A spread may or may not supply the property, so the tool reports it as unverifiable.',
    ideal: 'missing-required-property',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      removeRequired(site, rng);
      site.spread = 'baseProps';
      return { site };
    },
  },
  {
    id: 'wrapper-function-typo',
    description: 'a misspelled event name passed to a wrapper (logEvent) that is not a configured tracker',
    expectation: 'missed by design',
    note: 'Only the configured tracker names are matched, so a wrapper is never seen unless it is passed with --tracker.',
    ideal: 'unknown-event',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.callee = 'logEvent';
      site.event = typo(site.event, rng);
      return { site };
    },
  },
  {
    id: 'aliased-tracker-typo',
    description: 'a misspelled event name passed through const t = analytics.track',
    expectation: 'missed by design',
    note: 'An alias has a different name from any configured tracker.',
    ideal: 'unknown-event',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.preamble = ['const t = analytics.track;'];
      site.callee = 't';
      site.event = typo(site.event, rng);
      return { site };
    },
  },
  {
    id: 'element-access-typo',
    description: "a misspelled event name passed to analytics['track']",
    expectation: 'missed by design',
    note: 'Calls through bracket access are not matched.',
    ideal: 'unknown-event',
    where: 'call',
    make: (rng) => {
      const site = randomCall(rng);
      site.callee = "analytics['track']";
      site.event = typo(site.event, rng);
      return { site };
    },
  },
  {
    id: 'type-mismatch-in-non-literal-value',
    description: 'an integer property given String(count)',
    expectation: 'missed by design',
    note: 'A value that is not a literal is not compared; the run reports how many such values it skipped.',
    ideal: 'type-mismatch',
    where: 'prop',
    make: (rng) => {
      const site = find(rng, (s) => s.props.some((p) => p.kind === 'int'));
      const p = site.props.find((q) => q.kind === 'int')!;
      p.value = 'String(count)';
      p.kind = 'expr';
      return { site, prop: p.key };
    },
  },
];

function piiSite(rng: Rng, literal: string): { site: CallSite; prop: string } {
  const site = randomCall(rng, 'signup_completed');
  site.props = site.props.filter((p) => p.key !== 'referrer');
  site.props.push({ key: 'referrer', value: literal, kind: 'expr' });
  rng.shuffle(site.props);
  return { site, prop: 'referrer' };
}

export interface CodeOutcomeCounts {
  seed: number;
  injected: number;
  exact: number;
  unverifiable: number;
  missed: number;
  stray: number;
}

export function runCodeFamily(plan: ReturnType<typeof loadPlan>, family: CodeFamily, seed: number, n: number = FAULTS_PER_FAMILY): CodeOutcomeCounts {
  const rng = new Rng(seed * 7919 + family.id.length);
  const faulty: Array<{ site: CallSite; prop?: string }> = [];
  for (let i = 0; i < n; i++) faulty.push(family.make(rng));
  const sites: Array<{ site: CallSite; faultIndex: number }> = faulty.map((f, i) => ({ site: f.site, faultIndex: i }));
  for (let i = 0; i < n; i++) sites.push({ site: randomCall(rng), faultIndex: -1 });
  rng.shuffle(sites);
  const corpus = buildCorpus(sites.map((s) => s.site), 20);
  const findings: Finding[] = [];
  for (const [file, text] of corpus.files) findings.push(...lintSource(file, text, plan, ['track', 'analytics.track']).findings);
  const result: CodeOutcomeCounts = { seed, injected: n, exact: 0, unverifiable: 0, missed: 0, stray: 0 };
  const inFault = (file: string, line: number) =>
    sites.some((s, i) => s.faultIndex >= 0 && corpus.placed[i]!.file === file && line >= corpus.placed[i]!.range[0] && line <= corpus.placed[i]!.range[1]);
  sites.forEach((s, i) => {
    if (s.faultIndex < 0) return;
    const placed = corpus.placed[i]!;
    const fault = faulty[s.faultIndex]!;
    const line = family.where === 'call' ? placed.line : placed.propLine[fault.prop!]!;
    const here = findings.filter((f) => f.file === placed.file && f.line !== undefined && f.line >= placed.range[0] && f.line <= placed.range[1]);
    let outcome: Outcome = 'missed';
    if (here.some((f) => f.type === family.ideal && f.line === line)) outcome = 'exact';
    else if (here.some((f) => UNVERIFIABLE_TYPES.has(f.type) && f.line === placed.line)) outcome = 'unverifiable';
    result[outcome]++;
  });
  result.stray = findings.filter((f) => !inFault(f.file ?? '', f.line ?? 0)).length;
  return result;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function main(): void {
  const root = repoRoot();
  const plan = loadPlan(join(root, 'examples', 'tracking-plan.json'));
  const meta = runMeta(root);
  const started = Date.now();

  const baseline: Array<{ seed: number; events: number; findings: number }> = [];
  const streamRows = STREAM_FAMILIES.map((family) => {
    const perSeed: FamilyOutcome[] = [];
    for (const seed of SEEDS) {
      const clean = generateCleanStream({ users: STREAM_USERS, seed });
      if (family === STREAM_FAMILIES[0]) {
        const control = checkLines(clean.map((e) => JSON.stringify(e)), plan, { examplesPerType: ALL });
        baseline.push({ seed, events: clean.length, findings: control.findingsTotal });
      }
      const events = clean.map((e) => structuredClone(e));
      const { lines, faults } = family.run(events, new Rng(seed * 31 + family.id.length), FAULTS_PER_FAMILY);
      const report = checkLines(lines, plan, { examplesPerType: ALL });
      const scored = scoreStream(report, faults);
      perSeed.push({ seed, injected: faults.length, detected: scored.detected, stray: scored.stray });
    }
    const rates = perSeed.map((s) => pct(s.detected, s.injected));
    return {
      id: family.id,
      description: family.description,
      expectation: family.expectation,
      note: family.note,
      injected: perSeed.reduce((a, s) => a + s.injected, 0),
      detected: perSeed.reduce((a, s) => a + s.detected, 0),
      stray: perSeed.reduce((a, s) => a + s.stray, 0),
      rate: summarize(rates),
      perSeed,
    };
  });

  const cardinalitySeeds = SEEDS.map((seed) => {
    let detected = 0;
    let falsePositives = 0;
    for (let t = 0; t < CARDINALITY_TRIALS; t++) {
      if (cardinalityTrial(plan, seed * 1000 + t, true).flagged) detected++;
      if (cardinalityTrial(plan, seed * 1000 + t, false).flagged) falsePositives++;
    }
    return { seed, injected: CARDINALITY_TRIALS, detected, falsePositives };
  });

  const codeBaseline: Array<{ seed: number; calls: number; findings: number }> = [];
  for (const seed of SEEDS) {
    const rng = new Rng(seed);
    const sites = Array.from({ length: 2000 }, () => randomCall(rng));
    const corpus = buildCorpus(sites, 20);
    let count = 0;
    for (const [file, text] of corpus.files) count += lintSource(file, text, plan, ['track', 'analytics.track']).findings.length;
    codeBaseline.push({ seed, calls: sites.length, findings: count });
  }
  const codeRows = CODE_FAMILIES.map((family) => {
    const perSeed = SEEDS.map((seed) => runCodeFamily(plan, family, seed));
    return {
      id: family.id,
      description: family.description,
      expectation: family.expectation,
      note: family.note,
      idealFinding: family.ideal,
      injected: perSeed.reduce((a, s) => a + s.injected, 0),
      exact: perSeed.reduce((a, s) => a + s.exact, 0),
      unverifiable: perSeed.reduce((a, s) => a + s.unverifiable, 0),
      missed: perSeed.reduce((a, s) => a + s.missed, 0),
      stray: perSeed.reduce((a, s) => a + s.stray, 0),
      exactRate: summarize(perSeed.map((s) => pct(s.exact, s.injected))),
      flaggedRate: summarize(perSeed.map((s) => pct(s.exact + s.unverifiable, s.injected))),
      perSeed,
    };
  });

  writeJson(join(root, 'results', 'fault-injection', 'fault-injection.json'), {
    description:
      'Detection rate per fault family. Faults are injected into a clean synthetic stream and a clean synthetic code corpus; a fault counts as detected when the tool reports the expected finding at the injected place.',
    command: 'node dist/scripts/fault-injection.js',
    seeds: SEEDS,
    faultsPerFamilyPerSeed: FAULTS_PER_FAMILY,
    stream: {
      usersPerStream: STREAM_USERS,
      generator: 'scripts/synthetic.ts, generateCleanStream, for examples/tracking-plan.json',
      cleanBaseline: baseline,
      families: streamRows,
      highCardinality: {
        description: `80 signup events in a 600-user stream given unique referrer values (plan bound 40); ${CARDINALITY_TRIALS} streams per seed, each also run without the injection as a control`,
        perSeed: cardinalitySeeds,
      },
    },
    code: {
      generator: 'scripts/code-corpus.ts, calls built from the example plan in several syntaxes (track, analytics.track, analytics?.track; three quote styles; single-line and multi-line; quoted keys; .ts, .tsx and .js files)',
      callsPerCorpus: FAULTS_PER_FAMILY * 2,
      cleanBaseline: codeBaseline,
      families: codeRows,
    },
    meta,
    elapsedSeconds: Math.round((Date.now() - started) / 100) / 10,
  });
  console.log('wrote results/fault-injection/fault-injection.json');
  for (const r of streamRows) console.log(`stream ${r.id}: ${r.detected}/${r.injected} (stray ${r.stray})`);
  for (const r of codeRows) console.log(`code ${r.id}: exact ${r.exact}, unverifiable ${r.unverifiable}, missed ${r.missed} of ${r.injected} (stray ${r.stray})`);
  console.log(`high-cardinality: ${cardinalitySeeds.map((s) => `${s.detected}/${s.injected} (fp ${s.falsePositives})`).join(' ')}`);
  console.log(`stream baseline findings: ${baseline.map((b) => b.findings).join(',')}; code baseline findings: ${codeBaseline.map((b) => b.findings).join(',')}`);
}

if (isMain(import.meta.url)) main();
