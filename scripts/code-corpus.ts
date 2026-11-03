// A synthetic code corpus for the example plan: tracker calls in varied syntax, with the position of
// every call and property recorded so faults can be injected and located exactly.
import type { Rng } from './synthetic.js';

type Quote = "'" | '"' | '`';

export interface PropSite {
  key: string;
  /** The value as it appears in source. */
  value: string;
  /** What the value is, for choosing faults. */
  kind: 'enum' | 'int' | 'bool' | 'number' | 'expr';
  /** The enum literal when kind is enum. */
  enumValue?: string;
}

export interface CallSite {
  event: string;
  /** Source text of the tracker function, such as track or analytics.track. */
  callee: string;
  /** When set, the first argument is this expression instead of a string literal. */
  eventExpr?: string;
  props: PropSite[];
  /** When set, the second argument is this expression instead of an object literal. */
  propsExpr?: string;
  /** Source text of a spread placed first in the object literal. */
  spread?: string;
  multiline: boolean;
  quote: Quote;
  quoteKeys: boolean;
  /** Lines emitted before the call inside the same function. */
  preamble: string[];
}

interface PropTemplate {
  key: string;
  required: boolean;
  kind: PropSite['kind'];
  values?: string[];
  exprs?: string[];
}

export const TEMPLATES: Record<string, PropTemplate[]> = {
  signup_completed: [
    { key: 'method', required: true, kind: 'enum', values: ['email', 'google', 'sso'] },
    { key: 'referrer', required: false, kind: 'expr', exprs: ['src.referrer', 'ctx.ref'] },
  ],
  workspace_created: [
    { key: 'workspace_id', required: true, kind: 'expr', exprs: ['workspace.id', 'ctx.workspaceId', 'wsId'] },
    { key: 'plan_tier', required: true, kind: 'enum', values: ['free', 'plus', 'business'] },
    { key: 'seats', required: false, kind: 'int', exprs: ['seatCount', 'members.length'] },
  ],
  page_created: [
    { key: 'workspace_id', required: true, kind: 'expr', exprs: ['workspace.id', 'ctx.workspaceId', 'wsId'] },
    { key: 'template', required: true, kind: 'enum', values: ['blank', 'meeting_notes', 'project_plan', 'wiki'] },
    { key: 'source', required: false, kind: 'enum', values: ['sidebar', 'shortcut', 'onboarding'] },
    { key: 'block_count', required: false, kind: 'int', exprs: ['blocks.length', 'count'] },
  ],
  invite_sent: [
    { key: 'workspace_id', required: true, kind: 'expr', exprs: ['workspace.id', 'ctx.workspaceId', 'wsId'] },
    { key: 'invitee_count', required: true, kind: 'int', exprs: ['emails.length', 'inviteCount'] },
    { key: 'role', required: true, kind: 'enum', values: ['member', 'guest'] },
    { key: 'bulk', required: false, kind: 'bool', exprs: ['isBulk', 'emails.length > 1', '!!flag'] },
  ],
  onboarding_step_completed: [
    { key: 'step', required: true, kind: 'enum', values: ['profile', 'import', 'first_page', 'invite'] },
    { key: 'duration_ms', required: false, kind: 'number', exprs: ['elapsedMs', 'timer.stop()'] },
    { key: 'skipped', required: true, kind: 'bool', exprs: ['wasSkipped', 'a > b'] },
  ],
};

export const EVENT_NAMES = Object.keys(TEMPLATES);

export function quoted(text: string, quote: Quote): string {
  return `${quote}${text}${quote}`;
}

function valueFor(rng: Rng, t: PropTemplate): PropSite {
  switch (t.kind) {
    case 'enum': {
      const v = rng.pick(t.values!);
      return { key: t.key, value: v, kind: 'enum', enumValue: v };
    }
    case 'int':
      return { key: t.key, value: rng.chance(0.6) ? String(rng.range(1, 50)) : rng.pick(t.exprs!), kind: 'int' };
    case 'bool':
      return { key: t.key, value: rng.chance(0.5) ? String(rng.chance(0.5)) : rng.pick(t.exprs!), kind: 'bool' };
    case 'number':
      return { key: t.key, value: rng.chance(0.5) ? String(Math.round(rng.next() * 9000) / 10) : rng.pick(t.exprs!), kind: 'number' };
    default:
      return { key: t.key, value: rng.pick(t.exprs!), kind: 'expr' };
  }
}

/** A call that conforms to the plan. */
export function randomCall(rng: Rng, event: string = rng.pick(EVENT_NAMES)): CallSite {
  const props: PropSite[] = [];
  for (const t of TEMPLATES[event]!) {
    if (t.required || rng.chance(0.5)) props.push(valueFor(rng, t));
  }
  rng.shuffle(props);
  return {
    event,
    callee: rng.pick(['track', 'analytics.track', 'analytics?.track']),
    props,
    multiline: rng.chance(0.5),
    quote: rng.pick(["'", '"', '`'] as const),
    quoteKeys: rng.chance(0.15),
    preamble: [],
  };
}

export interface Rendered {
  lines: string[];
  /** Offset of the line where the call expression starts. */
  callOffset: number;
  /** Offset of the line holding each property. */
  propOffset: Record<string, number>;
}

function renderValue(p: PropSite, quote: Quote): string {
  return p.kind === 'enum' ? quoted(p.value, quote) : p.value;
}

function renderKey(key: string, quoteKeys: boolean, quote: Quote): string {
  if (quoteKeys) return quoted(key, quote === '`' ? "'" : quote);
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quoted(key, "'");
}

export function renderCall(site: CallSite): Rendered {
  const lines: string[] = [...site.preamble];
  const callOffset = lines.length;
  const propOffset: Record<string, number> = {};
  const first = site.eventExpr ?? quoted(site.event, site.quote);
  if (site.propsExpr !== undefined) {
    lines.push(`${site.callee}(${first}, ${site.propsExpr});`);
    return { lines, callOffset, propOffset };
  }
  const entries = site.props.map((p) => ({ key: p.key, text: `${renderKey(p.key, site.quoteKeys, site.quote)}: ${renderValue(p, site.quote)}` }));
  if (site.spread !== undefined) entries.unshift({ key: '...', text: `...${site.spread}` });
  if (entries.length === 0) {
    lines.push(`${site.callee}(${first}, {});`);
    return { lines, callOffset, propOffset };
  }
  if (!site.multiline) {
    for (const e of entries) propOffset[e.key] = callOffset;
    lines.push(`${site.callee}(${first}, { ${entries.map((e) => e.text).join(', ')} });`);
    return { lines, callOffset, propOffset };
  }
  lines.push(`${site.callee}(${first}, {`);
  entries.forEach((e, i) => {
    propOffset[e.key] = callOffset + 1 + i;
    lines.push(`  ${e.text},`);
  });
  lines.push('});');
  return { lines, callOffset, propOffset };
}

export interface PlacedCall {
  file: string;
  /** 1-based line where the call starts. */
  line: number;
  /** 1-based line of each property. */
  propLine: Record<string, number>;
  /** 1-based inclusive line range of the whole function around the call. */
  range: [number, number];
}

export interface Corpus {
  files: Map<string, string>;
  placed: PlacedCall[];
}

/** Packs calls into files of `perFile` calls. Each call sits in its own function. Returns where each landed. */
export function buildCorpus(calls: readonly CallSite[], perFile: number): Corpus {
  const files = new Map<string, string>();
  const placed: PlacedCall[] = [];
  const extensions = ['ts', 'tsx', 'js'] as const;
  for (let start = 0, fileIndex = 0; start < calls.length; start += perFile, fileIndex++) {
    const ext = extensions[fileIndex % extensions.length]!;
    const name = `file-${String(fileIndex).padStart(3, '0')}.${ext}`;
    const lines: string[] = ["import { analytics, track } from './tracker';", ''];
    calls.slice(start, start + perFile).forEach((site, k) => {
      const header = ext === 'js' ? `export function handler${k}(ctx) {` : `export function handler${k}(ctx: Ctx): void {`;
      const rendered = renderCall(site);
      const functionLine = lines.length + 1;
      lines.push(header);
      for (const l of rendered.lines) lines.push(`  ${l}`);
      lines.push('}', '');
      const propLine: Record<string, number> = {};
      for (const [key, off] of Object.entries(rendered.propOffset)) propLine[key] = functionLine + 1 + off;
      placed.push({ file: name, line: functionLine + 1 + rendered.callOffset, propLine, range: [functionLine, lines.length - 1] });
    });
    files.set(name, `${lines.join('\n')}\n`);
  }
  return { files, placed };
}
