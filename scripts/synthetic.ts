// Synthetic data used by the examples, the tests and the measurements. Nothing here is real traffic.

export class Rng {
  private state: number;
  private spare: number | null = null;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** mulberry32: a 32-bit generator, deterministic for a given seed. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }

  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((a, [, w]) => a + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r < 0) return item;
    }
    return items[items.length - 1]![0];
  }

  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }

  /** Marsaglia and Tsang. */
  gamma(shape: number): number {
    if (shape < 1) return this.gamma(shape + 1) * this.next() ** (1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal();
      const v = (1 + c * x) ** 3;
      if (v <= 0) continue;
      const u = this.next();
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  beta(a: number, b: number): number {
    const x = this.gamma(a);
    const y = this.gamma(b);
    return x / (x + y);
  }

  /** Knuth's method; fine for the small means used here. */
  poisson(lambda: number): number {
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
  }
}

export interface StreamEvent {
  event_id: string;
  name: string;
  user_id: string;
  ts: number;
  received_at: number;
  properties: Record<string, unknown>;
}

export const REFERRERS: readonly string[] = Array.from({ length: 30 }, (_, i) => `ref_${String(i + 1).padStart(2, '0')}`);
export const PLAN_FILE_HINT = 'examples/tracking-plan.json';

const METHODS = ['email', 'google', 'sso'] as const;
const TIERS: ReadonlyArray<readonly [string, number]> = [['free', 0.7], ['plus', 0.2], ['business', 0.1]];
const TEMPLATES = ['blank', 'meeting_notes', 'project_plan', 'wiki'] as const;
const SOURCES = ['sidebar', 'shortcut', 'onboarding'] as const;
const ROLES = ['member', 'guest'] as const;
const STEPS = ['profile', 'import', 'first_page', 'invite'] as const;

export interface StreamContext {
  seed: number;
  counter: number;
  startMs: number;
  spanMs: number;
}

/** One user's events for the example plan, in time order, every one conforming to it. */
export function userEvents(rng: Rng, index: number, ctx: StreamContext): StreamEvent[] {
  const user = `usr_${String(index).padStart(7, '0')}`;
  const out: StreamEvent[] = [];
  const emit = (name: string, ts: number, properties: Record<string, unknown>): void => {
    ctx.counter++;
    out.push({
      event_id: `evt_${ctx.seed}_${ctx.counter.toString(36)}`,
      name,
      user_id: user,
      ts,
      received_at: ts + 50 + rng.int(4950),
      properties,
    });
  };

  let t = ctx.startMs + rng.int(ctx.spanMs);
  const signup: Record<string, unknown> = { method: rng.pick(METHODS) };
  if (rng.chance(0.7)) signup['referrer'] = rng.pick(REFERRERS);
  if (rng.chance(0.3)) signup['contact_email'] = `person${index}@example.com`;
  emit('signup_completed', t, signup);

  if (rng.chance(0.85)) {
    const ws = `ws_${index}`;
    t += rng.range(1_000, 600_000);
    const workspace: Record<string, unknown> = { workspace_id: ws, plan_tier: rng.weighted(TIERS) };
    if (rng.chance(0.6)) workspace['seats'] = rng.range(1, 20);
    emit('workspace_created', t, workspace);

    const pages = 1 + Math.min(4, rng.poisson(1.2));
    let firstPageAt = 0;
    for (let p = 0; p < pages; p++) {
      t += rng.range(10_000, 7_200_000);
      if (p === 0) firstPageAt = t;
      const page: Record<string, unknown> = { workspace_id: ws, template: rng.pick(TEMPLATES) };
      if (rng.chance(0.7)) page['source'] = rng.pick(SOURCES);
      if (rng.chance(0.5)) page['block_count'] = rng.range(1, 60);
      emit('page_created', t, page);
    }

    if (rng.chance(0.4)) {
      const invite: Record<string, unknown> = { workspace_id: ws, invitee_count: rng.range(1, 10), role: rng.pick(ROLES) };
      if (rng.chance(0.3)) invite['bulk'] = rng.chance(0.5);
      emit('invite_sent', Math.max(t, firstPageAt) + rng.range(60_000, 86_400_000), invite);
    }
  }

  const steps = [...STEPS];
  rng.shuffle(steps);
  const stepCount = rng.int(4);
  for (let s = 0; s < stepCount; s++) {
    const step: Record<string, unknown> = { step: steps[s], skipped: rng.chance(0.25) };
    if (rng.chance(0.8)) step['duration_ms'] = Math.round(rng.next() * 90_000 * 10) / 10;
    emit('onboarding_step_completed', ctx.startMs + rng.int(ctx.spanMs), step);
  }
  return out;
}

export const DEFAULT_START_MS = Date.UTC(2026, 9, 1, 0, 0, 0);

/** A clean stream sorted by arrival time. */
export function generateCleanStream(options: { users: number; seed: number; startMs?: number; spanMs?: number }): StreamEvent[] {
  const rng = new Rng(options.seed);
  const ctx: StreamContext = { seed: options.seed, counter: 0, startMs: options.startMs ?? DEFAULT_START_MS, spanMs: options.spanMs ?? 7 * 86_400_000 };
  const events: StreamEvent[] = [];
  for (let i = 0; i < options.users; i++) events.push(...userEvents(rng, i, ctx));
  events.sort((a, b) => a.received_at - b.received_at || (a.event_id < b.event_id ? -1 : 1));
  return events;
}

export function toJsonl(events: readonly StreamEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** How the requests of one user relate to the outcome. */
export interface ClusterModel {
  /** Mean success probability across users. */
  p0: number;
  /** Intra-class correlation of the requests of one user, in [0, 1). 0 means every request has probability p0. */
  icc: number;
  /** Mean number of requests per user (at least 1): requests = 1 + Poisson(meanRequests - 1). */
  meanRequests: number;
  /** When set, requests = 1 + Poisson(heavy * p_u): users who succeed more often also make more requests. */
  heavy?: number;
}

export interface DrawnUser {
  requests: number;
  successes: number;
  p: number;
}

export function drawUser(rng: Rng, model: ClusterModel): DrawnUser {
  let p = model.p0;
  if (model.icc > 0) {
    const kappa = 1 / model.icc - 1;
    p = rng.beta(model.p0 * kappa, (1 - model.p0) * kappa);
  }
  const lambda = model.heavy === undefined ? model.meanRequests - 1 : model.heavy * p;
  const requests = 1 + rng.poisson(lambda);
  let successes = 0;
  for (let i = 0; i < requests; i++) if (rng.next() < p) successes++;
  return { requests, successes, p };
}

/** The ratio sum(successes) / sum(requests) that the estimator targets, in closed form. */
export function trueRatio(model: ClusterModel): number {
  if (model.heavy === undefined) return model.p0;
  const ep2 = model.p0 ** 2 + model.p0 * (1 - model.p0) * model.icc;
  return (model.p0 + model.heavy * ep2) / (1 + model.heavy * model.p0);
}
