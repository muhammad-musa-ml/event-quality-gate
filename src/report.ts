import type { StreamReport } from './check-stream.js';
import { countByType, isUnverifiable } from './findings.js';
import type { Finding } from './findings.js';
import type { PathLintResult } from './lint-code.js';
import type { ReadoutReport } from './readout.js';
import type { RatioInterval } from './stats.js';

function counts(findings: readonly Finding[]): string {
  return Object.entries(countByType(findings))
    .map(([type, n]) => `${type} ${n}`)
    .join(', ');
}

export function renderLintText(result: PathLintResult, trackers: readonly string[], failed: boolean): string {
  const lines: string[] = [];
  for (const f of result.findings) {
    const where = f.file === undefined ? 'eqg' : `${f.file}:${f.line ?? 0}:${f.column ?? 0}`;
    lines.push(`${where}: ${f.type}: ${f.message}`);
  }
  lines.push(
    `eqg lint-code: scanned ${result.filesScanned} file${result.filesScanned === 1 ? '' : 's'}, ` +
      `${result.callsFound} call${result.callsFound === 1 ? '' : 's'} to ${trackers.join(' or ')} ` +
      `(${result.callsChecked} with a literal event name); ${result.valuesNotChecked} property value${result.valuesNotChecked === 1 ? '' : 's'} not compared because they are not literals`,
  );
  if (result.findings.length > 0) lines.push(`findings: ${result.findings.length} (${counts(result.findings)})`);
  if (failed) {
    lines.push('FAIL');
  } else if (result.findings.length > 0) {
    const n = result.findings.filter(isUnverifiable).length;
    lines.push(`PASS: ${n} unverifiable finding${n === 1 ? '' : 's'} allowed by --allow-unverifiable`);
  } else {
    lines.push('PASS: no findings');
  }
  return `${lines.join('\n')}\n`;
}

function minutes(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function renderStreamText(r: StreamReport, source: string, failed: boolean): string {
  const lines: string[] = [];
  lines.push(`eqg check-stream: ${source}: ${r.lines} lines, ${r.events} events, ${r.valid} with a well-formed envelope, ${r.users} users, ${r.duplicates} repeated event id${r.duplicates === 1 ? '' : 's'}`);
  lines.push(
    `late and skew checks looked at ${r.lateChecked} events (late after ${minutes(r.options.lateToleranceMs)}, skew beyond ${minutes(r.options.skewToleranceMs)}); ` +
      `${r.missingReceivedAt} event${r.missingReceivedAt === 1 ? '' : 's'} had no received_at and were not checked`,
  );
  const types = Object.keys(r.counts);
  if (types.length > 0) {
    lines.push('findings by type:');
    for (const t of types) {
      lines.push(`  ${t}: ${r.counts[t]}`);
      for (const ex of r.examples[t] ?? []) {
        const bits = [ex.event !== undefined ? `event ${ex.event}` : '', ex.user !== undefined ? `user ${ex.user}` : '', ex.eventId !== undefined ? `id ${ex.eventId}` : ''].filter(Boolean);
        lines.push(`    ${ex.line > 0 ? `line ${ex.line}: ` : ''}${ex.message}${bits.length ? ` (${bits.join(', ')})` : ''}`);
      }
    }
  }
  lines.push(failed ? `FAIL: ${r.findingsTotal} finding${r.findingsTotal === 1 ? '' : 's'}` : 'PASS: no findings');
  return `${lines.join('\n')}\n`;
}

function interval(i: RatioInterval): string {
  return `${i.ratio.toFixed(5)} [${i.lower.toFixed(5)}, ${i.upper.toFixed(5)}]`;
}

export function renderReadoutText(r: ReadoutReport, source: string, failed: boolean): string {
  const lines: string[] = [];
  lines.push(`eqg readout: ${source}: ${r.rows} rows, ${r.users} users analysed, ${r.rowsIgnored} rows in unplanned arms, ${r.usersInMultipleArms} users in more than one arm`);
  if (r.srm) {
    const s = r.srm;
    lines.push(
      `sample ratio: ${s.arms.map((a, i) => `${a} ${s.observed[i]} (expected ${s.expected[i]!.toFixed(1)})`).join(', ')}; ` +
        `chi-square ${s.chi2.toFixed(3)}, df ${s.df}, p ${s.p < 1e-3 ? s.p.toExponential(2) : s.p.toFixed(4)}, alpha ${s.alpha}: ${s.passed ? 'ok' : 'MISMATCH'}`,
    );
  }
  const pct = `${Math.round(r.options.level * 1000) / 10}%`;
  for (const a of r.arms) {
    lines.push(`arm ${a.arm}: ${a.users} users, ${a.requests} requests`);
    if (a.clustered && a.naive) {
      lines.push(`  by user (delta method, ${pct}): ${interval(a.clustered)}`);
      lines.push(`  by request (treated as independent): ${interval(a.naive)}`);
    } else {
      lines.push('  no interval (see findings)');
    }
  }
  for (const c of r.comparisons) {
    lines.push(`${c.arm} minus ${c.control}:`);
    lines.push(`  by user:    ${c.clustered.diff.toFixed(5)} [${c.clustered.lower.toFixed(5)}, ${c.clustered.upper.toFixed(5)}], ${c.clusteredExcludesZero ? 'excludes' : 'includes'} zero`);
    lines.push(`  by request: ${c.naive.diff.toFixed(5)} [${c.naive.lower.toFixed(5)}, ${c.naive.upper.toFixed(5)}], ${c.naiveExcludesZero ? 'excludes' : 'includes'} zero`);
    lines.push(`  the user-level interval is ${c.intervalWidthRatio.toFixed(2)} times as wide as the request-level one`);
    if (c.naiveExcludesZero !== c.clusteredExcludesZero) {
      lines.push(`  note: the two intervals disagree about zero; the user-level one is the one to read, because users were randomised`);
    }
  }
  if (r.cuped) {
    lines.push(
      `CUPED on the mean per-user total of y (a different quantity from the ratio above): theta ${r.cuped.theta.toFixed(5)}, ` +
        `${r.cuped.usersWithCovariate} users with a pre-period value, ${r.cuped.usersImputed} given the mean`,
    );
    for (const c of r.cuped.comparisons) {
      lines.push(`  ${c.arm}: raw ${c.raw.diff.toFixed(5)} [${c.raw.lower.toFixed(5)}, ${c.raw.upper.toFixed(5)}]; adjusted ${c.adjusted.diff.toFixed(5)} [${c.adjusted.lower.toFixed(5)}, ${c.adjusted.upper.toFixed(5)}]; variance ratio ${c.varianceRatio.toFixed(4)}`);
    }
  }
  for (const f of r.findings) lines.push(`${f.type}: ${f.message}`);
  lines.push(failed ? `FAIL: ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}` : 'PASS: no findings');
  return `${lines.join('\n')}\n`;
}
