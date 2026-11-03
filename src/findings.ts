export type FindingType =
  | 'unknown-event'
  | 'missing-required-property'
  | 'unexpected-property'
  | 'type-mismatch'
  | 'enum-violation'
  | 'pii-shaped-value'
  | 'non-literal-event-name'
  | 'unverifiable-properties'
  | 'no-tracker-calls'
  | 'parse-error'
  | 'invalid-json'
  | 'invalid-envelope'
  | 'duplicate-event-id'
  | 'funnel-out-of-order'
  | 'late-event'
  | 'clock-skew'
  | 'high-cardinality'
  | 'no-events';

/** A finding of an "unverifiable" type means the tool could not decide; it still counts against the gate unless the caller allows it. */
export const UNVERIFIABLE_TYPES: ReadonlySet<FindingType> = new Set<FindingType>([
  'non-literal-event-name',
  'unverifiable-properties',
]);

export interface Finding {
  type: FindingType;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  event?: string;
  property?: string;
}

export function isUnverifiable(f: Finding): boolean {
  return UNVERIFIABLE_TYPES.has(f.type);
}

export function countByType(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** True when the findings should fail a gate. */
export function failsGate(findings: readonly Finding[], allowUnverifiable: boolean): boolean {
  return findings.some((f) => !(allowUnverifiable && isUnverifiable(f)));
}
