import { readFileSync } from 'node:fs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { PlanError, getEvent, getProperty, loadPlan, parsePlan } from '../src/plan.js';

const minimal = {
  version: 1,
  events: { signup: { properties: { method: { type: 'string', enum: ['email', 'sso'] } }, required: ['method'] } },
};

function issuesOf(input: unknown): string[] {
  try {
    parsePlan(input);
  } catch (e) {
    if (e instanceof PlanError) return e.issues;
    throw e;
  }
  return [];
}

describe('parsePlan: accepts', () => {
  it('a minimal plan and fills defaults', () => {
    const plan = parsePlan(minimal);
    expect(Object.keys(plan.events)).toEqual(['signup']);
    expect(plan.events['signup']?.required).toEqual(['method']);
    expect(plan.funnel).toEqual([]);
  });

  it('an event with no properties at all', () => {
    const plan = parsePlan({ version: 1, events: { ping: {} } });
    expect(plan.events['ping']).toEqual({ properties: {}, required: [] });
  });

  it('every property field, a funnel and the schema pointer', () => {
    const plan = parsePlan({
      $schema: './schema/tracking-plan.schema.json',
      version: 1,
      events: {
        a: {
          description: 'first',
          properties: {
            id: { type: 'string', maxDistinct: 10, description: 'bounded' },
            email: { type: 'string', pii: true },
            n: { type: 'integer', enum: [1, 2, 3] },
            f: { type: 'number', enum: [0.5, 1.5] },
            b: { type: 'boolean' },
          },
          required: ['id'],
        },
        b: {},
      },
      funnel: ['a', 'b'],
    });
    expect(plan.funnel).toEqual(['a', 'b']);
    expect(plan.events['a']?.properties['email']?.pii).toBe(true);
    expect(plan.events['a']?.properties['id']?.maxDistinct).toBe(10);
  });
});

describe('parsePlan: refuses a malformed plan and says where', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['null', null, /^\(root\): must be an object/],
    ['an array', [], /^\(root\): must be an object/],
    ['a wrong version', { version: 2, events: { a: {} } }, /^version: must be 1/],
    ['a missing version', { events: { a: {} } }, /^version: must be 1/],
    ['an unknown root key', { version: 1, events: { a: {} }, evnts: {} }, /^evnts: unknown key/],
    ['events missing', { version: 1 }, /^events: must be an object/],
    ['events empty', { version: 1, events: {} }, /^events: must declare at least one event/],
    ['an event that is not an object', { version: 1, events: { a: 3 } }, /^events\.a: must be an object/],
    ['an empty event name', { version: 1, events: { '': {} } }, /^events\.\(empty name\): event names must not be empty/],
    ['an event name with edge whitespace', { version: 1, events: { ' a': {} } }, /event names must not start or end with whitespace/],
    ['an unknown event key', { version: 1, events: { a: { propertys: {} } } }, /^events\.a\.propertys: unknown key/],
    ['properties that are not an object', { version: 1, events: { a: { properties: [] } } }, /^events\.a\.properties: must be an object/],
    ['a property with no type', { version: 1, events: { a: { properties: { p: {} } } } }, /^events\.a\.properties\.p\.type: must be one of string, number, integer, boolean/],
    ['a property with an unknown type', { version: 1, events: { a: { properties: { p: { type: 'date' } } } } }, /^events\.a\.properties\.p\.type: must be one of/],
    ['an unknown property key', { version: 1, events: { a: { properties: { p: { type: 'string', pii: true, min: 1 } } } } }, /^events\.a\.properties\.p\.min: unknown key/],
    ['pii that is not a boolean', { version: 1, events: { a: { properties: { p: { type: 'string', pii: 'yes' } } } } }, /^events\.a\.properties\.p\.pii: must be true or false/],
    ['an empty enum', { version: 1, events: { a: { properties: { p: { type: 'string', enum: [] } } } } }, /^events\.a\.properties\.p\.enum: must be a non-empty array/],
    ['an enum with a duplicate', { version: 1, events: { a: { properties: { p: { type: 'string', enum: ['x', 'x'] } } } } }, /^events\.a\.properties\.p\.enum\[1\]: duplicate value "x"/],
    ['an enum value of the wrong type', { version: 1, events: { a: { properties: { p: { type: 'string', enum: ['x', 3] } } } } }, /^events\.a\.properties\.p\.enum\[1\]: 3 is not a string/],
    ['a fractional integer enum value', { version: 1, events: { a: { properties: { p: { type: 'integer', enum: [1, 1.5] } } } } }, /^events\.a\.properties\.p\.enum\[1\]: 1.5 is not an integer/],
    ['maxDistinct of zero', { version: 1, events: { a: { properties: { p: { type: 'string', maxDistinct: 0 } } } } }, /^events\.a\.properties\.p\.maxDistinct: must be a positive integer/],
    ['maxDistinct that is fractional', { version: 1, events: { a: { properties: { p: { type: 'string', maxDistinct: 2.5 } } } } }, /^events\.a\.properties\.p\.maxDistinct: must be a positive integer/],
    ['maxDistinct beside an enum', { version: 1, events: { a: { properties: { p: { type: 'string', enum: ['x'], maxDistinct: 5 } } } } }, /^events\.a\.properties\.p\.maxDistinct: cannot be combined with enum/],
    ['maxDistinct on a boolean', { version: 1, events: { a: { properties: { p: { type: 'boolean', maxDistinct: 5 } } } } }, /^events\.a\.properties\.p\.maxDistinct: not allowed on a boolean property/],
    ['required that is not an array', { version: 1, events: { a: { required: 'p' } } }, /^events\.a\.required: must be an array/],
    ['required naming an undeclared property', { version: 1, events: { a: { properties: { p: { type: 'string' } }, required: ['q'] } } }, /^events\.a\.required\[0\]: "q" is not a declared property/],
    ['required with a duplicate', { version: 1, events: { a: { properties: { p: { type: 'string' } }, required: ['p', 'p'] } } }, /^events\.a\.required\[1\]: duplicate entry "p"/],
    ['funnel that is not an array', { version: 1, events: { a: {}, b: {} }, funnel: 'a' }, /^funnel: must be an array/],
    ['funnel with one step', { version: 1, events: { a: {}, b: {} }, funnel: ['a'] }, /^funnel: needs at least two steps/],
    ['funnel naming an unknown event', { version: 1, events: { a: {}, b: {} }, funnel: ['a', 'c'] }, /^funnel\[1\]: "c" is not a declared event/],
    ['funnel with a repeated step', { version: 1, events: { a: {}, b: {} }, funnel: ['a', 'b', 'a'] }, /^funnel\[2\]: duplicate step "a"/],
  ];
  for (const [label, input, pattern] of cases) {
    it(label, () => {
      const issues = issuesOf(input);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]).toMatch(pattern);
    });
  }

  it('reports every problem in one pass, not just the first', () => {
    const issues = issuesOf({
      version: 3,
      events: { a: { properties: { p: { type: 'nope' } }, required: ['zzz'] } },
      funnel: ['a', 'missing'],
    });
    expect(issues.length).toBe(4);
  });

  it('puts every issue in the error message', () => {
    expect(() => parsePlan({ version: 3, events: { a: {} } })).toThrowError(/tracking plan is invalid:\n {2}- version: must be 1/);
  });
});

describe('reserved and inherited names', () => {
  it('refuses __proto__ as an event name and as a property name', () => {
    expect(issuesOf({ version: 1, events: JSON.parse('{"__proto__": {}}') as unknown })[0]).toMatch(/"__proto__" is reserved/);
    const props = JSON.parse('{"__proto__": {"type": "string"}}') as unknown;
    expect(issuesOf({ version: 1, events: { a: { properties: props } } })[0]).toMatch(/"__proto__" is reserved/);
  });

  it('looks events and properties up as own keys only', () => {
    const plan = parsePlan(minimal);
    expect(getEvent(plan, 'signup')).toBeDefined();
    expect(getEvent(plan, 'constructor')).toBeUndefined();
    expect(getEvent(plan, 'toString')).toBeUndefined();
    const spec = getEvent(plan, 'signup');
    expect(spec && getProperty(spec, 'method')).toBeDefined();
    expect(spec && getProperty(spec, 'hasOwnProperty')).toBeUndefined();
  });
});

describe('loadPlan', () => {
  it('reads a plan file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eqg-plan-'));
    try {
      const file = join(dir, 'plan.json');
      writeFileSync(file, JSON.stringify(minimal));
      expect(Object.keys(loadPlan(file).events)).toEqual(['signup']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a file that does not exist', () => {
    expect(() => loadPlan(join(tmpdir(), 'eqg-no-such-plan.json'))).toThrowError(/cannot read tracking plan .*eqg-no-such-plan\.json/);
  });

  it('names a file that is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eqg-plan-'));
    try {
      const file = join(dir, 'plan.json');
      writeFileSync(file, '{"version": 1,');
      expect(() => loadPlan(file)).toThrowError(/is not valid JSON/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the example plan shipped with the repository', () => {
    const plan = loadPlan(fileURLToPath(new URL('../examples/tracking-plan.json', import.meta.url)));
    expect(Object.keys(plan.events).length).toBeGreaterThanOrEqual(5);
    expect(plan.funnel.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the JSON Schema file agrees with the validator on structure', () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/tracking-plan.schema.json', import.meta.url), 'utf8')) as object;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);

  const structural: Array<[string, unknown]> = [
    ['a minimal plan', minimal],
    ['null', null],
    ['version 2', { version: 2, events: { a: {} } }],
    ['no events', { version: 1 }],
    ['empty events', { version: 1, events: {} }],
    ['an unknown root key', { version: 1, events: { a: {} }, evnts: 1 }],
    ['an unknown type', { version: 1, events: { a: { properties: { p: { type: 'date' } } } } }],
    ['an empty enum', { version: 1, events: { a: { properties: { p: { type: 'string', enum: [] } } } } }],
    ['maxDistinct zero', { version: 1, events: { a: { properties: { p: { type: 'string', maxDistinct: 0 } } } } }],
    ['pii as a string', { version: 1, events: { a: { properties: { p: { type: 'string', pii: 'yes' } } } } }],
    ['an unknown event key', { version: 1, events: { a: { propertys: {} } } }],
    ['funnel with one step', { version: 1, events: { a: {}, b: {} }, funnel: ['a'] }],
    ['a full plan', { version: 1, events: { a: { properties: { p: { type: 'integer', enum: [1, 2], pii: false } }, required: ['p'] }, b: {} }, funnel: ['a', 'b'] }],
  ];
  for (const [label, input] of structural) {
    it(`both agree on ${label}`, () => {
      expect(validate(input)).toBe(issuesOf(input).length === 0);
    });
  }

  it('accepts the example plan', () => {
    const example = JSON.parse(readFileSync(new URL('../examples/tracking-plan.json', import.meta.url), 'utf8')) as unknown;
    expect(validate(example)).toBe(true);
  });
});
