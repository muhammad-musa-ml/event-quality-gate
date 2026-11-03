import { readFileSync } from 'node:fs';

export type PropType = 'string' | 'number' | 'integer' | 'boolean';
export type Scalar = string | number | boolean;

export interface PropertySpec {
  type: PropType;
  enum?: Scalar[];
  pii?: boolean;
  maxDistinct?: number;
  description?: string;
}

export interface EventSpec {
  description?: string;
  properties: Record<string, PropertySpec>;
  required: string[];
}

export interface TrackingPlan {
  version: 1;
  events: Record<string, EventSpec>;
  funnel: string[];
}

export class PlanError extends Error {
  readonly issues: string[];
  constructor(issues: string[], file?: string) {
    super(`tracking plan${file === undefined ? '' : ` ${file}`} is invalid:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'PlanError';
    this.issues = issues;
  }
}

const TYPES: readonly PropType[] = ['string', 'number', 'integer', 'boolean'];
const ROOT_KEYS = new Set(['$schema', 'description', 'version', 'events', 'funnel']);
const EVENT_KEYS = new Set(['description', 'properties', 'required']);
const PROPERTY_KEYS = new Set(['type', 'enum', 'pii', 'maxDistinct', 'description']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function describeValue(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
}

/** True when `value` is acceptable for a property of declared type `type`. */
export function matchesType(type: PropType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
  }
}

function parseProperty(raw: unknown, path: string, issues: string[]): PropertySpec | undefined {
  if (!isObject(raw)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!PROPERTY_KEYS.has(key)) issues.push(`${path}.${key}: unknown key`);
  }
  const type = raw['type'];
  if (typeof type !== 'string' || !TYPES.includes(type as PropType)) {
    issues.push(`${path}.type: must be one of ${TYPES.join(', ')}`);
    return undefined;
  }
  const spec: PropertySpec = { type: type as PropType };

  const enumRaw = raw['enum'];
  if (enumRaw !== undefined) {
    if (!Array.isArray(enumRaw) || enumRaw.length === 0) {
      issues.push(`${path}.enum: must be a non-empty array`);
    } else {
      const seen = new Set<unknown>();
      enumRaw.forEach((value: unknown, i) => {
        if (!matchesType(spec.type, value)) {
          const noun = spec.type === 'integer' ? 'an integer' : spec.type === 'number' ? 'a finite number' : `a ${spec.type}`;
          issues.push(`${path}.enum[${i}]: ${describeValue(value)} is not ${noun}`);
        } else if (seen.has(value)) {
          issues.push(`${path}.enum[${i}]: duplicate value ${describeValue(value)}`);
        }
        seen.add(value);
      });
      spec.enum = enumRaw as Scalar[];
    }
  }

  if (raw['pii'] !== undefined) {
    if (typeof raw['pii'] !== 'boolean') issues.push(`${path}.pii: must be true or false`);
    else spec.pii = raw['pii'];
  }

  if (raw['maxDistinct'] !== undefined) {
    const m = raw['maxDistinct'];
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1) {
      issues.push(`${path}.maxDistinct: must be a positive integer`);
    } else if (spec.type === 'boolean') {
      issues.push(`${path}.maxDistinct: not allowed on a boolean property`);
    } else if (raw['enum'] !== undefined) {
      issues.push(`${path}.maxDistinct: cannot be combined with enum (an enum already bounds the values)`);
    } else {
      spec.maxDistinct = m;
    }
  }

  if (raw['description'] !== undefined) {
    if (typeof raw['description'] !== 'string') issues.push(`${path}.description: must be a string`);
    else spec.description = raw['description'];
  }
  return spec;
}

function parseEvent(name: string, raw: unknown, issues: string[]): EventSpec | undefined {
  const path = `events.${name === '' ? '(empty name)' : name}`;
  if (name === '') issues.push(`${path}: event names must not be empty`);
  else if (name !== name.trim()) issues.push(`${path}: event names must not start or end with whitespace`);
  else if (name === '__proto__') issues.push(`${path}: "__proto__" is reserved`);
  if (!isObject(raw)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!EVENT_KEYS.has(key)) issues.push(`${path}.${key}: unknown key`);
  }
  const properties: Record<string, PropertySpec> = {};
  const rawProps = raw['properties'];
  if (rawProps !== undefined) {
    if (!isObject(rawProps)) {
      issues.push(`${path}.properties: must be an object`);
    } else {
      for (const [propName, propRaw] of Object.entries(rawProps)) {
        if (propName === '__proto__') {
          issues.push(`${path}.properties.${propName}: "__proto__" is reserved`);
          continue;
        }
        const spec = parseProperty(propRaw, `${path}.properties.${propName}`, issues);
        if (spec) properties[propName] = spec;
      }
    }
  }
  const required: string[] = [];
  const rawRequired = raw['required'];
  if (rawRequired !== undefined) {
    if (!Array.isArray(rawRequired)) {
      issues.push(`${path}.required: must be an array of property names`);
    } else {
      const seen = new Set<string>();
      rawRequired.forEach((entry: unknown, i) => {
        if (typeof entry !== 'string') {
          issues.push(`${path}.required[${i}]: must be a string`);
        } else if (seen.has(entry)) {
          issues.push(`${path}.required[${i}]: duplicate entry "${entry}"`);
        } else if (!Object.prototype.hasOwnProperty.call(isObject(rawProps) ? rawProps : {}, entry)) {
          issues.push(`${path}.required[${i}]: "${entry}" is not a declared property`);
        } else {
          required.push(entry);
        }
        if (typeof entry === 'string') seen.add(entry);
      });
    }
  }
  const spec: EventSpec = { properties, required };
  if (typeof raw['description'] === 'string') spec.description = raw['description'];
  else if (raw['description'] !== undefined) issues.push(`${path}.description: must be a string`);
  return spec;
}

/** Validates an already-parsed plan. Every problem is collected; the error lists all of them. */
export function parsePlan(input: unknown): TrackingPlan {
  const issues: string[] = [];
  if (!isObject(input)) throw new PlanError(['(root): must be an object']);

  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) issues.push(`${key}: unknown key`);
  }
  if (input['version'] !== 1) issues.push('version: must be 1');

  const events: Record<string, EventSpec> = {};
  const rawEvents = input['events'];
  if (!isObject(rawEvents)) {
    issues.push('events: must be an object mapping event names to event specs');
  } else if (Object.keys(rawEvents).length === 0) {
    issues.push('events: must declare at least one event');
  } else {
    for (const [name, raw] of Object.entries(rawEvents)) {
      const spec = parseEvent(name, raw, issues);
      if (spec) events[name] = spec;
    }
  }

  const funnel: string[] = [];
  const rawFunnel = input['funnel'];
  if (rawFunnel !== undefined) {
    if (!Array.isArray(rawFunnel)) {
      issues.push('funnel: must be an array of event names');
    } else {
      if (rawFunnel.length < 2) issues.push('funnel: needs at least two steps');
      const seen = new Set<string>();
      rawFunnel.forEach((step: unknown, i) => {
        if (typeof step !== 'string') {
          issues.push(`funnel[${i}]: must be a string`);
        } else if (seen.has(step)) {
          issues.push(`funnel[${i}]: duplicate step "${step}"`);
        } else if (!isObject(rawEvents) || !Object.prototype.hasOwnProperty.call(rawEvents, step)) {
          issues.push(`funnel[${i}]: "${step}" is not a declared event`);
        } else {
          funnel.push(step);
        }
        if (typeof step === 'string') seen.add(step);
      });
    }
  }

  if (issues.length > 0) throw new PlanError(issues);
  return { version: 1, events, funnel };
}

export function loadPlan(path: string): TrackingPlan {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`cannot read tracking plan ${path}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`tracking plan ${path} is not valid JSON: ${(e as Error).message}`);
  }
  try {
    return parsePlan(parsed);
  } catch (e) {
    if (e instanceof PlanError) throw new PlanError(e.issues, path);
    throw e;
  }
}

/** Own-property lookup, so a stream event named "constructor" is an unknown event, not a function. */
export function getEvent(plan: TrackingPlan, name: string): EventSpec | undefined {
  return Object.hasOwn(plan.events, name) ? plan.events[name] : undefined;
}

export function getProperty(spec: EventSpec, name: string): PropertySpec | undefined {
  return Object.hasOwn(spec.properties, name) ? spec.properties[name] : undefined;
}
