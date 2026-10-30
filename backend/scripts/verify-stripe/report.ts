/**
 * Payments go-live slice 39 - the dated report the one-command run writes.
 */
export interface FlowResult {
  id: string;
  status: 'pass' | 'fail' | 'skip';
  assertions: number;
  ms: number;
  error?: string;
  reason?: string;
}

export interface ReportMeta {
  startedAt: Date;
  /** The backend under test. */
  apiUrl: string;
  /** 'local' = rows were removed after; 'shared' = nothing was deleted and `fixtures` lists what is left. */
  databaseKind: 'local' | 'shared';
  fixtures: string[];
}

export function reportFileName(d: Date): string {
  return `sandbox-suite-report-${d.toISOString().slice(0, 10)}.md`;
}

export function suiteVerdict(results: FlowResult[], opts: { strict: boolean }): 'green' | 'red' {
  if (results.length === 0) return 'red';
  if (results.some((r) => r.status === 'fail')) return 'red';
  if (opts.strict && results.some((r) => r.status === 'skip')) return 'red';
  return 'green';
}

const LABEL = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' } as const;

export function renderReport(results: FlowResult[], meta: ReportMeta): string {
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');
  const assertions = results.reduce((n, r) => n + r.assertions, 0);
  const verdict = failed.length === 0 && skipped.length === 0 && results.length > 0 ? 'GREEN' : 'NOT GREEN';
  const lines: string[] = [];
  lines.push(`# Sandbox verification suite - ${meta.startedAt.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`**Result: ${verdict}** - ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped, ${assertions} assertions.`);
  lines.push('');
  lines.push(`- Started: ${meta.startedAt.toISOString()}`);
  lines.push(`- Backend under test: ${meta.apiUrl}`);
  lines.push(`- Payment processor: sandbox only`);
  lines.push(`- Database: ${meta.databaseKind === 'shared' ? 'shared (nothing was deleted)' : 'local (rows removed after the run)'}`);
  lines.push('');
  lines.push('| Flow | Result | Assertions | Seconds |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| ${r.id} | ${LABEL[r.status]} | ${r.assertions} | ${(r.ms / 1000).toFixed(1)} |`);
  }
  if (failed.length > 0) {
    lines.push('');
    lines.push('## Failures');
    for (const r of failed) lines.push(`- ${r.id}: ${r.error ?? 'failed'}`);
  }
  if (skipped.length > 0) {
    lines.push('');
    lines.push('## Skipped');
    for (const r of skipped) lines.push(`- ${r.id}: ${r.reason ?? 'skipped'}`);
  }
  if (meta.fixtures.length > 0) {
    lines.push('');
    lines.push('## Left behind (not deleted)');
    for (const f of meta.fixtures) lines.push(`- ${f}`);
  }
  lines.push('');
  return lines.join('\n');
}
