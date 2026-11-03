import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_STREAM_OPTIONS, StreamChecker, checkLines, checkStreamFile, parseDuration } from '../src/check-stream.js';
import type { StreamOptions } from '../src/check-stream.js';
import { parsePlan } from '../src/plan.js';

const plan = parsePlan({
  version: 1,
  events: {
    signup: {
      properties: {
        method: { type: 'string', enum: ['email', 'sso'] },
        seats: { type: 'integer' },
        ok: { type: 'boolean' },
        note: { type: 'string' },
        ref: { type: 'string', maxDistinct: 3 },
        email: { type: 'string', pii: true },
        ratio: { type: 'number' },
      },
      required: ['method'],
    },
    workspace: {
      properties: { id: { type: 'string' }, tag: { type: 'string', maxDistinct: 2 }, shard: { type: 'integer', maxDistinct: 2 } },
      required: ['id'],
    },
    invite: {},
  },
  funnel: ['signup', 'workspace', 'invite'],
});

const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
let n = 0;
beforeEach(() => {
  n = 0;
});

function line(o: Record<string, unknown> = {}): string {
  n++;
  return JSON.stringify({ event_id: `e${n}`, name: 'signup', user_id: 'u1', ts: T0, received_at: T0 + 1000, properties: { method: 'email' }, ...o });
}

function run(lines: string[], options: Partial<StreamOptions> = {}) {
  return checkLines(lines, plan, options);
}

describe('a clean stream', () => {
  it('has no findings and counts what it read', () => {
    const r = run([
      line({ user_id: 'u1' }),
      line({ user_id: 'u1', name: 'workspace', ts: T0 + 10, received_at: T0 + 20, properties: { id: 'w1' } }),
      line({ user_id: 'u2', properties: { method: 'sso', seats: 3, ok: true, note: 'hello', ratio: 0.5 } }),
      line({ user_id: 'u1', name: 'invite', ts: T0 + 30, received_at: T0 + 40, properties: {} }),
      line({ user_id: 'u3', name: 'invite', properties: undefined }),
    ]);
    expect(r.findingsTotal).toBe(0);
    expect(r.events).toBe(5);
    expect(r.valid).toBe(5);
    expect(r.users).toBe(3);
    expect(r.counts).toEqual({});
  });
});

describe('a stream that checked nothing fails', () => {
  it('reports no-events for empty input', () => {
    const r = run([]);
    expect(r.counts).toEqual({ 'no-events': 1 });
    expect(r.findingsTotal).toBe(1);
  });

  it('reports no-events when every line is blank', () => {
    const r = run(['', '   ', '\t']);
    expect(r.counts).toEqual({ 'no-events': 1 });
    expect(r.lines).toBe(3);
    expect(r.events).toBe(0);
  });

  it('does not add no-events when lines were read but all are invalid', () => {
    const r = run(['{oops', '[]']);
    expect(r.counts['no-events']).toBeUndefined();
    expect(r.counts['invalid-json']).toBe(1);
    expect(r.counts['invalid-envelope']).toBe(1);
    expect(r.valid).toBe(0);
  });
});

describe('envelope problems', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['a missing event_id', { event_id: undefined }],
    ['an empty event_id', { event_id: '' }],
    ['a non-string event_id', { event_id: 12 }],
    ['a missing name', { name: undefined }],
    ['an empty user_id', { user_id: '' }],
    ['a missing ts', { ts: undefined }],
    ['a non-ISO ts string', { ts: '11/02/2026' }],
    ['an ISO ts without an offset', { ts: '2026-11-02T12:00:00' }],
    ['a numeric string ts', { ts: '1730000000000' }],
    ['a negative ts', { ts: -5 }],
    ['a ts beyond the range of a Date', { ts: 9e15 }],
    ['an invalid received_at', { received_at: 'yesterday' }],
    ['properties that are an array', { properties: [] }],
    ['properties that are a string', { properties: 'x' }],
    ['properties that are null', { properties: null }],
  ];
  for (const [label, override] of bad) {
    it(`flags ${label}`, () => {
      const r = run([line(override)]);
      expect(r.counts).toEqual({ 'invalid-envelope': 1 });
      expect(r.valid).toBe(0);
    });
  }

  it('accepts ISO timestamps with Z and with offsets, and compares them as instants', () => {
    const r = run([
      line({ ts: '2026-11-02T12:00:00Z', received_at: '2026-11-02T14:00:01+02:00' }),
      line({ ts: '2026-11-02T14:00:00.000+02:00', received_at: '2026-11-02T12:00:01.500Z' }),
    ]);
    expect(r.findingsTotal).toBe(0);
    expect(r.lateChecked).toBe(2);
  });

  it('flags a received_at that is missing when it is required, and otherwise says it was not checked', () => {
    const lines = [line({ received_at: undefined })];
    const optional = run(lines);
    expect(optional.findingsTotal).toBe(0);
    expect(optional.missingReceivedAt).toBe(1);
    expect(optional.lateChecked).toBe(0);
    expect(optional.skewChecked).toBe(0);
    const required = run(lines, { requireReceivedAt: true });
    expect(required.counts).toEqual({ 'invalid-envelope': 1 });
  });
});

describe('invalid JSON', () => {
  it('flags a truncated line and a line that is not an object', () => {
    const r = run([line(), '{"event_id": "x", "name":', '"just a string"', '12', 'null']);
    expect(r.counts['invalid-json']).toBe(1);
    expect(r.counts['invalid-envelope']).toBe(3);
    expect(r.examples['invalid-json']?.[0]?.line).toBe(2);
  });

  it('flags a line over the length limit without parsing it', () => {
    const r = run([line(), `{"pad":"${'x'.repeat(1_100_000)}"}`]);
    expect(r.counts['invalid-json']).toBe(1);
    expect(r.examples['invalid-json']?.[0]?.message).toMatch(/longer than/);
  });
});

describe('schema conformance', () => {
  it('flags an unknown event, including inherited names, and checks nothing else about it', () => {
    const r = run([line({ name: 'signp', properties: { whatever: 1 } }), line({ name: 'constructor' }), line({ name: 'toString' })]);
    expect(r.counts).toEqual({ 'unknown-event': 3 });
  });

  it('flags a missing required property, and null in a required property as a type mismatch', () => {
    const r = run([line({ properties: {} }), line({ properties: { method: null } })]);
    expect(r.counts).toEqual({ 'missing-required-property': 1, 'type-mismatch': 1 });
  });

  it('flags an unexpected property, including an inherited-looking name', () => {
    const r = run([line({ properties: { method: 'email', extra: 1, constructor: 2 } })]);
    expect(r.counts).toEqual({ 'unexpected-property': 2 });
  });

  it('flags type mismatches', () => {
    const r = run([
      line({ properties: { method: 'email', seats: '5' } }),
      line({ properties: { method: 'email', seats: 1.5 } }),
      line({ properties: { method: 'email', ok: 'true' } }),
      line({ properties: { method: 'email', ratio: 'x' } }),
      line({ properties: { method: 'email', note: { a: 1 } } }),
      line({ properties: { method: 'email', note: [1] } }),
      line({ properties: { method: 5 } }),
    ]);
    expect(r.counts).toEqual({ 'type-mismatch': 7 });
  });

  it('accepts an integer for a number property and 5.0 for an integer', () => {
    expect(run([line({ properties: { method: 'email', ratio: 3, seats: 5.0 } })]).findingsTotal).toBe(0);
  });

  it('flags an enum violation and does not also call it a type mismatch', () => {
    const r = run([line({ properties: { method: 'phone' } })]);
    expect(r.counts).toEqual({ 'enum-violation': 1 });
  });

  it('records where each finding is', () => {
    const r = run([line(), line({ properties: { method: 'email', seats: 'x' }, user_id: 'u9' })]);
    const ex = r.examples['type-mismatch']?.[0];
    expect(ex).toMatchObject({ line: 2, event: 'signup', user: 'u9', property: 'seats', eventId: 'e2' });
  });
});

describe('duplicate event ids', () => {
  it('flags the second and later copies, and does not check a copy again', () => {
    const first = line({ event_id: 'dup' });
    const bad = line({ event_id: 'dup', properties: { method: 'phone' } });
    const third = line({ event_id: 'dup' });
    const r = run([first, bad, third]);
    expect(r.counts).toEqual({ 'duplicate-event-id': 2 });
    expect(r.duplicates).toBe(2);
    expect(r.examples['duplicate-event-id']?.[0]?.line).toBe(2);
  });

  it('does not treat different ids with the same content as duplicates', () => {
    expect(run([line({ event_id: 'a' }), line({ event_id: 'b' })]).findingsTotal).toBe(0);
  });
});

describe('funnel order', () => {
  const ws = (user: string, ts: number) => line({ user_id: user, name: 'workspace', ts, received_at: ts + 1, properties: { id: 'w' } });
  const su = (user: string, ts: number) => line({ user_id: user, name: 'signup', ts, received_at: ts + 1 });
  const inv = (user: string, ts: number) => line({ user_id: user, name: 'invite', ts, received_at: ts + 1, properties: {} });

  it('flags a user who reaches a later step before an earlier one', () => {
    const r = run([su('u1', T0 + 100), ws('u1', T0 + 50)]);
    expect(r.counts).toEqual({ 'funnel-out-of-order': 1 });
    expect(r.examples['funnel-out-of-order']?.[0]).toMatchObject({ user: 'u1' });
    expect(r.examples['funnel-out-of-order']?.[0]?.message).toMatch(/workspace.*signup/);
  });

  it('does not mind arrival order when the timestamps are in order', () => {
    expect(run([ws('u1', T0 + 50), su('u1', T0 + 10), inv('u1', T0 + 90)]).findingsTotal).toBe(0);
  });

  it('allows equal timestamps and does not require every step', () => {
    expect(run([su('u1', T0), ws('u1', T0)]).findingsTotal).toBe(0);
    expect(run([ws('u1', T0), inv('u1', T0 + 5)]).findingsTotal).toBe(0);
  });

  it('uses each step\'s earliest timestamp', () => {
    expect(run([su('u1', T0 + 10), ws('u1', T0 + 5), su('u1', T0 + 1)]).findingsTotal).toBe(0);
    expect(run([su('u1', T0 + 10), ws('u1', T0 + 5), su('u1', T0 + 20)]).counts).toEqual({ 'funnel-out-of-order': 1 });
  });

  it('counts a user once, however many pairs are out of order', () => {
    const r = run([inv('u1', T0 + 1), ws('u1', T0 + 2), su('u1', T0 + 3), inv('u2', T0 + 1), su('u2', T0 + 2)]);
    expect(r.counts).toEqual({ 'funnel-out-of-order': 2 });
  });

  it('keeps users apart', () => {
    expect(run([su('u1', T0 + 100), ws('u2', T0 + 50)]).findingsTotal).toBe(0);
  });

  it('ignores a stream whose plan has no funnel', () => {
    const noFunnel = parsePlan({ version: 1, events: { a: {}, b: {} } });
    const r = checkLines([line({ name: 'b', properties: {} }), line({ name: 'a', ts: T0 + 5, properties: {} })], noFunnel, {});
    expect(r.findingsTotal).toBe(0);
  });

  it('does not count a duplicate delivery toward the order', () => {
    const r = run([su('u1', T0 + 100), ws('u1', T0 + 150), line({ event_id: 'e1', user_id: 'u1', name: 'workspace', ts: T0 + 1, properties: { id: 'w' } })]);
    expect(r.counts).toEqual({ 'duplicate-event-id': 1 });
  });
});

describe('late events and clock skew', () => {
  const late = DEFAULT_STREAM_OPTIONS.lateToleranceMs;
  const skew = DEFAULT_STREAM_OPTIONS.skewToleranceMs;

  it('allows a delay exactly at the tolerance and flags one millisecond more', () => {
    expect(run([line({ received_at: T0 + late })]).findingsTotal).toBe(0);
    expect(run([line({ received_at: T0 + late + 1 })]).counts).toEqual({ 'late-event': 1 });
  });

  it('allows a client clock ahead by exactly the tolerance and flags one millisecond more', () => {
    expect(run([line({ received_at: T0 - skew })]).findingsTotal).toBe(0);
    expect(run([line({ received_at: T0 - skew - 1 })]).counts).toEqual({ 'clock-skew': 1 });
  });

  it('uses the tolerances it is given and reports them', () => {
    const r = run([line({ received_at: T0 + 11_000 })], { lateToleranceMs: 10_000, skewToleranceMs: 1_000 });
    expect(r.counts).toEqual({ 'late-event': 1 });
    expect(r.options.lateToleranceMs).toBe(10_000);
    expect(r.options.skewToleranceMs).toBe(1_000);
  });

  it('counts how many events the two checks could look at', () => {
    const r = run([line(), line({ received_at: undefined }), line()]);
    expect(r.lateChecked).toBe(2);
    expect(r.skewChecked).toBe(2);
    expect(r.missingReceivedAt).toBe(1);
  });
});

describe('high-cardinality properties', () => {
  it('stays quiet at the bound and flags the first value past it, once per property', () => {
    const at = run(['a', 'b', 'c', 'a'].map((ref) => line({ properties: { method: 'email', ref } })));
    expect(at.findingsTotal).toBe(0);
    const over = run(['a', 'b', 'c', 'd', 'e', 'f'].map((ref) => line({ properties: { method: 'email', ref } })));
    expect(over.counts).toEqual({ 'high-cardinality': 1 });
    expect(over.examples['high-cardinality']?.[0]).toMatchObject({ line: 4, property: 'ref', event: 'signup' });
  });

  it('keeps events and properties apart', () => {
    const r = run([
      ...['a', 'b', 'c'].map((ref) => line({ properties: { method: 'email', ref } })),
      ...['x', 'y'].map((tag) => line({ name: 'workspace', properties: { id: 'w', tag } })),
    ]);
    expect(r.findingsTotal).toBe(0);
  });

  it('bounds numeric properties too, and ignores values that already failed the type check', () => {
    const numbered = (shard: unknown) => line({ name: 'workspace', properties: { id: 'w', shard } });
    expect(run([1, 2, 1, 2].map(numbered)).findingsTotal).toBe(0);
    expect(run([1, 2, 3].map(numbered)).counts).toEqual({ 'high-cardinality': 1 });
    expect(run(['a', 'b', 'c'].map(numbered)).counts).toEqual({ 'type-mismatch': 3 });
  });

  it('does not count values of a duplicate delivery', () => {
    const r = run(['a', 'b', 'c'].map((ref) => line({ event_id: 'same', properties: { method: 'email', ref } })));
    expect(r.counts).toEqual({ 'duplicate-event-id': 2 });
  });
});

describe('PII-shaped values', () => {
  it('flags an email or phone in a property that is not declared pii', () => {
    const r = run([
      line({ properties: { method: 'email', note: 'jane.doe@example.com' } }),
      line({ properties: { method: 'email', note: '(555) 010-0199' } }),
      line({ properties: { method: 'email', note: 'hello' } }),
    ]);
    expect(r.counts).toEqual({ 'pii-shaped-value': 2 });
  });

  it('accepts them in a property declared pii', () => {
    expect(run([line({ properties: { method: 'email', email: 'jane.doe@example.com' } })]).findingsTotal).toBe(0);
  });

  it('flags a PII-shaped value in an unexpected property as both problems', () => {
    const r = run([line({ properties: { method: 'email', contact: 'jane.doe@example.com' } })]);
    expect(r.counts).toEqual({ 'pii-shaped-value': 1, 'unexpected-property': 1 });
  });

  it('does not read numbers or non-strings as PII', () => {
    expect(run([line({ properties: { method: 'email', seats: 5550100199 } })]).findingsTotal).toBe(0);
  });
});

describe('reporting', () => {
  it('counts every finding but keeps only a few examples per type', () => {
    const lines = Array.from({ length: 10 }, () => line({ name: 'nope' }));
    const r = run(lines, { examplesPerType: 2 });
    expect(r.counts).toEqual({ 'unknown-event': 10 });
    expect(r.examples['unknown-event']).toHaveLength(2);
    expect(r.examples['unknown-event']?.map((e) => e.line)).toEqual([1, 2]);
    expect(r.findingsTotal).toBe(10);
  });

  it('reports a finding of each type once in the totals', () => {
    const r = run([line({ name: 'nope' }), line({ properties: {} }), '{bad']);
    expect(r.findingsTotal).toBe(3);
  });

  it('can be fed line by line', () => {
    const c = new StreamChecker(plan);
    c.addLine(line());
    c.addLine('');
    c.addLine(line({ name: 'x' }));
    const r = c.finish();
    expect(r.lines).toBe(3);
    expect(r.events).toBe(2);
    expect(r.counts).toEqual({ 'unknown-event': 1 });
  });
});

describe('checkStreamFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eqg-stream-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads CRLF files, blank lines, a byte order mark and a last line with no newline, with true line numbers', async () => {
    const file = join(dir, 's.jsonl');
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(file, `${bom}${line()}\r\n\r\n${line({ name: 'nope' })}\r\n${line()}`);
    const r = await checkStreamFile(file, plan);
    expect(r.lines).toBe(4);
    expect(r.events).toBe(3);
    expect(r.counts).toEqual({ 'unknown-event': 1 });
    expect(r.examples['unknown-event']?.[0]?.line).toBe(3);
  });

  it('fails an empty file', async () => {
    const file = join(dir, 'empty.jsonl');
    writeFileSync(file, '');
    expect((await checkStreamFile(file, plan)).counts).toEqual({ 'no-events': 1 });
  });

  it('rejects a file that does not exist', async () => {
    await expect(checkStreamFile(join(dir, 'missing.jsonl'), plan)).rejects.toThrowError(/cannot read/);
  });
});

describe('parseDuration', () => {
  it('reads units', () => {
    expect(parseDuration('1500ms')).toBe(1500);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('250')).toBe(250);
    expect(parseDuration('0')).toBe(0);
    expect(parseDuration('1.5m')).toBe(90_000);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'm', '-5m', '5 minutes', '1e3', 'NaN', '5mm']) {
      expect(() => parseDuration(bad), bad).toThrowError(/duration/);
    }
  });
});
