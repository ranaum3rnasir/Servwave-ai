/**
 * Mobile slice 62 (rubric TEST-06 performance part, PERF-03): the full route x device sweep, its
 * Lighthouse budget and the promotion check that requires its report.
 *
 * The decisions live in `scripts/mobile-sweep-lib.mjs` (pure) and are provoked here with small
 * fake inputs, one failure mode at a time, so each verdict is seen to go red. The drivers (the
 * Playwright run, Lighthouse itself) are exercised by the sweep, and the budget's own proof that it
 * can fail is e2e/mobile/lighthouse-budget-red.spec.ts. The last blocks are guards: the lists the
 * sweep depends on agree with the code (devices, routes, report slugs) and the promotion
 * checklist really names the run.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET,
  REQUIRED_DEVICE_IDS,
  REQUIRED_LIGHTHOUSE_IDS,
  PURGE_BLOCKERS,
  applyKnownFailing,
  buildSweepReport,
  checkSweepReport,
  clearPurgeBlockers,
  evaluateBudget,
  extractMetrics,
  flattenPlaywright,
  lighthouseVerdict,
  medianMetrics,
  renderSweepMarkdown,
  routeMatrix,
  stateIdOf,
  teardownWithRetries,
} from '../../scripts/mobile-sweep-lib.mjs';
import { GATE_DEVICES, SWEEP_DEVICES } from '../../e2e/mobile/devices';
import { ALL_STATES, KEY_STATES, SWEEP_REPORT_SLUGS, SWEEP_STATES, selectStates, type GateFixtures } from '../../e2e/mobile/routes';

const FRONTEND = resolve(__dirname, '../..');
const REPO = resolve(FRONTEND, '..');

// ── fakes ───────────────────────────────────────────────────────────────────────────────────────
const test_ = (projectName: string, status: 'expected' | 'unexpected' | 'flaky' | 'skipped', error?: string, annotations: Array<{ type: string }> = []) => ({
  projectName,
  status,
  annotations,
  results: [{ status: status === 'expected' || status === 'flaky' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed', ...(error ? { error: { message: error } } : {}) }],
});
const spec = (file: string, title: string, tests: ReturnType<typeof test_>[]) => ({ file, title, tests });
const json = (specs: ReturnType<typeof spec>[]) => ({ suites: [{ file: 'x', specs }] });

const DEVICES = REQUIRED_DEVICE_IDS.map((id) => ({ id, matrix: 'D?', viewport: '1x1', engine: 'chromium' }));
const STATES = ['home', 'leads', 'leads~filter'];
const goodRun = () =>
  json(
    STATES.map((s) => spec('gate.spec.ts', s === 'leads~filter' ? `${s} (overlay: filter)` : s, DEVICES.map((d) => test_(d.id, 'expected')))),
  );
const lh = (over: Partial<{ lcpMs: number; cls: number }> = {}, mode = 'enforce') =>
  REQUIRED_LIGHTHOUSE_IDS.map((id) => {
    const measured = { lcpMs: 1800, cls: 0.02, fcpMs: 900, tbtMs: 50, bytes: 1, performanceScore: 0.9, runs: 3, ...over };
    return { id, label: id, mode, measured, verdict: lighthouseVerdict({ id, mode: mode as 'enforce' }, measured) };
  });
const META = { startedAt: '2026-10-04T10:00:00.000Z', finishedAt: '2026-10-04T11:00:00.000Z', commit: 'a'.repeat(40), stagingSha: 'a'.repeat(40), branch: 'x', dirty: false, command: 'cmd', exitCode: 0 };
const build = (over: Record<string, unknown> = {}) =>
  buildSweepReport({ meta: { ...META }, playwright: goodRun(), devices: DEVICES, expectedStates: STATES, lighthouse: lh(), records: { reportPairs: 3 }, build: { ok: true }, ...over } as Parameters<typeof buildSweepReport>[0]);

// ── the Lighthouse budget ───────────────────────────────────────────────────────────────────────
describe('the Lighthouse budget (PERF-03: LCP at most 2.5 s, CLS at most 0.1)', () => {
  it('is the rubric budget', () => {
    expect(DEFAULT_BUDGET).toEqual({ lcpMs: 2500, cls: 0.1 });
  });

  it('passes a page inside the budget, and one exactly on it', () => {
    expect(evaluateBudget({ lcpMs: 1200, cls: 0.01 }).ok).toBe(true);
    expect(evaluateBudget({ lcpMs: 2500, cls: 0.1 }).ok).toBe(true);
  });

  it('fails a slow LCP, naming it', () => {
    const v = evaluateBudget({ lcpMs: 2501, cls: 0 });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual([expect.stringMatching(/^LCP 2\.50 s is over the 2\.5 s budget$/)]);
    expect(evaluateBudget({ lcpMs: 31_000, cls: 0 }).failures[0]).toMatch(/^LCP 31\.00 s/);
  });

  it('fails a layout shift, naming it', () => {
    const v = evaluateBudget({ lcpMs: 900, cls: 0.101 });
    expect(v.ok).toBe(false);
    expect(v.failures).toEqual([expect.stringMatching(/^CLS 0\.101 is over the 0\.1 budget$/)]);
  });

  it('reports both when both are over', () => {
    expect(evaluateBudget({ lcpMs: 9000, cls: 0.5 }).failures).toHaveLength(2);
  });

  it('fails a page that could not be measured: an unread budget is not a pass', () => {
    expect(evaluateBudget(null).ok).toBe(false);
    expect(evaluateBudget(undefined).failures[0]).toMatch(/could not be measured/);
    expect(evaluateBudget({ lcpMs: Number.NaN, cls: 0 } as never).ok).toBe(false);
  });

  it('judges a page by its mode: enforce fails the run, report only prints it', () => {
    const slow = { lcpMs: 4000, cls: 0 };
    expect(lighthouseVerdict({ id: 'a', mode: 'enforce' }, slow).status).toBe('fail');
    expect(lighthouseVerdict({ id: 'a', mode: 'report' }, slow).status).toBe('report');
    expect(lighthouseVerdict({ id: 'a', mode: 'report' }, { lcpMs: 1000, cls: 0 }).status).toBe('pass');
    // A report-mode page with a ceiling cannot get worse: over the ceiling it fails, between target and ceiling it reports.
    const capped = { id: 'a', mode: 'report' as const, ceiling: { lcpMs: 5000, cls: 0.1 } };
    expect(lighthouseVerdict(capped, { lcpMs: 4900, cls: 0 }).status).toBe('report');
    const worse = lighthouseVerdict(capped, { lcpMs: 5100, cls: 0 });
    expect(worse.status).toBe('fail');
    expect(worse.failures[0]).toMatch(/over this page's ceiling of 5\.0 s/);
    expect(lighthouseVerdict(capped, { lcpMs: 1000, cls: 0.3 }).status).toBe('fail');
    expect(lighthouseVerdict({ ...capped, mode: 'enforce' as const }, { lcpMs: 4900, cls: 0 }).status).toBe('fail');
    // A page can carry its own, never a looser default: the override is the page's.
    expect(lighthouseVerdict({ id: 'a', mode: 'enforce', budget: { lcpMs: 5000 } }, slow).status).toBe('pass');
  });

  it('reads the numbers out of a Lighthouse result, and the median over runs', () => {
    const lhr = (lcp: number, cls: number) => ({
      audits: {
        'largest-contentful-paint': { numericValue: lcp },
        'cumulative-layout-shift': { numericValue: cls },
        'first-contentful-paint': { numericValue: 500 },
        'total-blocking-time': { numericValue: 10 },
        'total-byte-weight': { numericValue: 1234 },
      },
      categories: { performance: { score: 0.8 } },
    });
    expect(extractMetrics(lhr(2000, 0.05))).toMatchObject({ lcpMs: 2000, cls: 0.05, fcpMs: 500, bytes: 1234, performanceScore: 0.8 });
    expect(extractMetrics({ audits: {} })).toBeNull();
    expect(extractMetrics(null)).toBeNull();
    const runs = [extractMetrics(lhr(3000, 0.2)), extractMetrics(lhr(1000, 0.0)), extractMetrics(lhr(2000, 0.1)), null];
    expect(medianMetrics(runs)).toMatchObject({ lcpMs: 2000, cls: 0.1, runs: 3 });
    expect(medianMetrics([null, null])).toBeNull();
  });
});

// ── the Playwright results, flattened ───────────────────────────────────────────────────────────
describe('reading the Playwright results', () => {
  it('maps expected, unexpected, flaky and skipped, and keeps the first lines of an error without colour codes', () => {
    const rows = flattenPlaywright(
      json([spec('gate.spec.ts', 'home', [test_('iphone-se', 'expected'), test_('galaxy-s24', 'unexpected', '\u001b[31mnew offender\u001b[0m\nsecond line'), test_('desktop', 'flaky'), test_('tab-s9', 'skipped')])]),
    );
    expect(rows.map((r) => [r.project, r.status])).toEqual([['iphone-se', 'pass'], ['galaxy-s24', 'fail'], ['desktop', 'flaky'], ['tab-s9', 'skipped']]);
    expect(rows[1]!.error).toBe('new offender | second line');
  });

  it('marks a page the gate skipped as known broken, apart from an overlay that does not exist at that width', () => {
    const rows = flattenPlaywright(
      json([spec('gate.spec.ts', 'report-estimate-conversion', [test_('desktop', 'skipped', undefined, [{ type: 'known broken' }]), test_('iphone-se', 'skipped')])]),
    );
    expect(rows.map((r) => r.status)).toEqual(['known', 'skipped']);
  });

  it('walks nested suites and takes the state id from a gate title', () => {
    const nested = { suites: [{ file: 'gate.spec.ts', suites: [{ specs: [spec('gate.spec.ts', 'leads~filter (overlay: filter)', [test_('desktop', 'expected')])] }] }] };
    const rows = flattenPlaywright(nested);
    expect(rows).toHaveLength(1);
    expect(stateIdOf(rows[0]!.title)).toBe('leads~filter');
    expect(stateIdOf('home')).toBe('home');
  });

  it('builds the route by device matrix from gate.spec.ts only, the worst result winning', () => {
    const rows = flattenPlaywright(
      json([
        spec('gate.spec.ts', 'home', [test_('iphone-se', 'expected'), test_('desktop', 'unexpected', 'x')]),
        spec('job-header.spec.ts', 'job header', [test_('iphone-se', 'expected')]),
      ]),
    );
    const m = routeMatrix(rows);
    expect(m.states).toEqual([{ id: 'home', cells: { 'iphone-se': 'pass', desktop: 'fail' } }]);
    expect(m.devices.sort()).toEqual(['desktop', 'iphone-se']);
  });
});

// ── the report ──────────────────────────────────────────────────────────────────────────────────
describe('the sweep report', () => {
  it('passes only when every device, every state and every Lighthouse page is in and green', () => {
    const r = build();
    expect(r.problems).toEqual([]);
    expect(r.overall).toBe('pass');
    expect(r.devices.every((d) => d.ran)).toBe(true);
    expect(r.routes).toMatchObject({ expected: 3, ran: 3, missing: [], gap: [] });
  });

  it('fails when a device never ran (the leftover devices must appear and run)', () => {
    const run = json(STATES.map((s) => spec('gate.spec.ts', s, DEVICES.filter((d) => d.id !== 'firefox').map((d) => test_(d.id, 'expected')))));
    const r = build({ playwright: run });
    expect(r.overall).toBe('fail');
    expect(r.notRunDevices).toEqual(['firefox']);
    expect(r.problems.join(' ')).toMatch(/devices that did not run: firefox/);
  });

  it('fails when a state never ran on any device (the leftover routes must appear and run)', () => {
    const r = build({ expectedStates: [...STATES, 'report-activity'] });
    expect(r.overall).toBe('fail');
    expect(r.routes.missing).toEqual(['report-activity']);
  });

  it('fails when a state is missing on one device', () => {
    const run = json([
      ...STATES.slice(0, 2).map((s) => spec('gate.spec.ts', s, DEVICES.map((d) => test_(d.id, 'expected')))),
      spec('gate.spec.ts', 'leads~filter (overlay: filter)', DEVICES.filter((d) => d.id !== 'pixel-7').map((d) => test_(d.id, 'expected'))),
    ]);
    const r = build({ playwright: run });
    expect(r.overall).toBe('fail');
    expect(r.routes.gap).toEqual([{ state: 'leads~filter', device: 'pixel-7' }]);
  });

  it('fails on a failing test and lists it', () => {
    const run = json([spec('gate.spec.ts', 'home', [...DEVICES.map((d) => test_(d.id, d.id === 'iphone-se' ? 'unexpected' : 'expected', 'boom')), ]), ...STATES.slice(1).map((s) => spec('gate.spec.ts', s, DEVICES.map((d) => test_(d.id, 'expected'))))]);
    const r = build({ playwright: run });
    expect(r.overall).toBe('fail');
    expect(r.failures).toEqual([expect.objectContaining({ project: 'iphone-se', title: 'home', error: 'boom' })]);
  });

  it('lists known-broken pages in the report without failing it, and still fails an unlisted crash', () => {
    const known = json([
      ...STATES.slice(0, 2).map((s) => spec('gate.spec.ts', s, DEVICES.map((d) => test_(d.id, 'expected')))),
      spec('gate.spec.ts', 'leads~filter (overlay: filter)', DEVICES.map((d) => test_(d.id, 'skipped', undefined, [{ type: 'known broken' }]))),
    ]);
    const r = build({ playwright: known });
    expect(r.overall).toBe('pass');
    expect(r.knownBroken).toEqual(['leads~filter']);
    expect(renderSweepMarkdown(r)).toMatch(/## Known broken pages[\s\S]*leads~filter/);
    // The same page failing (an unlisted crash) is a failure, not a note.
    const crash = json(STATES.map((s) => spec('gate.spec.ts', s, DEVICES.map((d) => test_(d.id, s === 'home' && d.id === 'pixel-7' ? 'unexpected' : 'expected', 'rendered the error screen')))));
    expect(build({ playwright: crash }).overall).toBe('fail');
  });

  it('counts a skipped overlay as not applicable, not as missing or failing', () => {
    const run = json(STATES.map((s) => spec('gate.spec.ts', s, DEVICES.map((d) => test_(d.id, s === 'leads~filter' && d.id === 'desktop' ? 'skipped' : 'expected')))));
    expect(build({ playwright: run }).overall).toBe('pass');
  });

  it('fails when the Playwright run exited non-zero, even with no failing row', () => {
    expect(build({ meta: { ...META, exitCode: 1 } }).problems.join(' ')).toMatch(/exited 1/);
  });

  it('fails a partial run: only the full sweep counts', () => {
    const r = build({ meta: { ...META, partial: true } });
    expect(r.overall).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/PARTIAL/);
  });

  it('fails when the production build failed', () => {
    expect(build({ build: { ok: false } }).overall).toBe('fail');
  });

  it('fails when a self-test fails: a check that cannot be shown red is not trusted', () => {
    const run = goodRun();
    run.suites[0]!.specs.push(spec('selftest.spec.ts', 'overflow goes red', [test_('selftest-touch', 'unexpected', 'it stayed green')]));
    const r = build({ playwright: run });
    expect(r.overall).toBe('fail');
    expect(r.selftestFailures).toHaveLength(1);
    expect(r.failures).toHaveLength(0);
  });

  it('fails a page over the Lighthouse budget, and passes a report-mode miss', () => {
    const over = build({ lighthouse: lh({ lcpMs: 4000 }) });
    expect(over.overall).toBe('fail');
    expect(over.problems.join(' ')).toMatch(/3 page\(s\) over the Lighthouse budget/);
    expect(build({ lighthouse: lh({ lcpMs: 4000 }, 'report') }).overall).toBe('pass');
  });

  it('fails when Lighthouse did not measure a required page', () => {
    const r = build({ lighthouse: lh().slice(0, 2) });
    expect(r.overall).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/Lighthouse did not measure: technician-landing/);
  });

  it('renders the matrix, the leftover devices and the Lighthouse table', () => {
    const md = renderSweepMarkdown(build());
    expect(md).toMatch(/^# Mobile sweep report: PASS/);
    for (const id of ['firefox', 'tab-s9', 'fold-unfolded', 'iphone-17-pro-max', 'iphone-se-landscape']) expect(md).toContain(`| ${id} |`);
    expect(md).toMatch(/\| leads~filter \|/);
    expect(md).toMatch(/Lighthouse \(mobile, budget: LCP at most 2\.5 s, CLS at most 0\.1\)/);
    expect(md).toMatch(/\| technician-landing \| enforce \| 3 \| 1\.80 s \| 0\.020 \|/);
    expect(renderSweepMarkdown(build({ meta: { ...META, exitCode: 1 } }))).toMatch(/^# Mobile sweep report: FAIL[\s\S]*## Why it failed/);
  });
});

// ── known-failing specs ─────────────────────────────────────────────────────────────────────────
const KF = {
  id: 'jobs-filter-created-tab',
  file: 'date-picker-sheet.spec.ts',
  title: 'jobs Filters popover',
  projects: ['iphone-se', 'galaxy-s24'],
  errorIncludes: "'Created' tab",
  reason: 'the Created tab is never found in the Filters popover',
  owner: 'slice 45',
};
const failingRun = (extra: ReturnType<typeof spec>[] = []) =>
  json([
    ...goodRun().suites[0]!.specs,
    spec('date-picker-sheet.spec.ts', 'jobs Filters popover', [test_('iphone-se', 'unexpected', "locator('Created' tab) not found"), test_('galaxy-s24', 'unexpected', "locator('Created' tab) not found"), test_('desktop', 'expected')]),
    ...extra,
  ]);

describe('known-failing specs (a stale targeted spec must not block every promotion forever)', () => {
  it('turns a recorded failure into known-failing, only for the listed spec, title, project and error', () => {
    const rows = flattenPlaywright(failingRun());
    const { rows: out, matched, stale } = applyKnownFailing(rows, [KF]);
    const mine = out.filter((r) => r.file === 'date-picker-sheet.spec.ts');
    expect(mine.map((r) => [r.project, r.status])).toEqual([['iphone-se', 'known-failing'], ['galaxy-s24', 'known-failing'], ['desktop', 'pass']]);
    expect(matched).toEqual({ [KF.id]: 2 });
    expect(stale).toEqual([]);
  });

  it('keeps a failure on a device that is not listed, with another error, in another title or in another file', () => {
    const left = (over: Record<string, unknown>) => applyKnownFailing(flattenPlaywright(failingRun()), [{ ...KF, ...over }]).rows.filter((r) => r.file === 'date-picker-sheet.spec.ts' && r.status === 'fail').length;
    expect(left({ projects: ['iphone-se'] })).toBe(1); // galaxy-s24 is a new failure
    expect(left({ errorIncludes: 'something else' })).toBe(2); // the failure changed shape
    expect(left({ title: 'another title' })).toBe(2);
    expect(left({ file: 'other.spec.ts' })).toBe(2);
  });

  it('treats an entry with no projects as every device', () => {
    const { projects: _p, ...noProjects } = KF;
    expect(applyKnownFailing(flattenPlaywright(failingRun()), [noProjects]).matched[KF.id]).toBe(2);
  });

  it('reports an entry that matched nothing as stale, so it can be deleted', () => {
    const { stale } = applyKnownFailing(flattenPlaywright(goodRun()), [KF]);
    expect(stale).toEqual([KF.id]);
  });

  it('does not fail the report, lists the spec in it, and does not let the non-zero exit code fail it alone', () => {
    const r = build({ playwright: failingRun(), meta: { ...META, exitCode: 1 }, knownFailing: [KF] });
    expect(r.overall).toBe('pass');
    expect(r.failures).toEqual([]);
    expect(r.knownFailing).toHaveLength(2);
    expect(r.knownFailing[0]).toMatchObject({ id: KF.id, owner: 'slice 45', project: 'iphone-se' });
    expect(renderSweepMarkdown(r)).toMatch(/## Known failing specs[\s\S]*date-picker-sheet\.spec\.ts[\s\S]*slice 45/);
  });

  it('still fails when a different test fails beside a recorded one', () => {
    const run = failingRun([spec('gate.spec.ts', 'home', [test_('pixel-7', 'unexpected', 'new offender')])]);
    const r = build({ playwright: run, meta: { ...META, exitCode: 1 }, knownFailing: [KF] });
    expect(r.overall).toBe('fail');
    expect(r.failures).toEqual([expect.objectContaining({ title: 'home', project: 'pixel-7' })]);
  });

  it('still fails on a non-zero exit with nothing failing, and on a Lighthouse miss, even with entries listed', () => {
    expect(build({ meta: { ...META, exitCode: 1 }, knownFailing: [KF] }).problems.join(' ')).toMatch(/exited 1/);
    const r = build({ playwright: failingRun(), meta: { ...META, exitCode: 1 }, knownFailing: [KF], lighthouse: lh({ lcpMs: 4000 }) });
    expect(r.overall).toBe('fail');
  });

  it('never hides a failing self-test', () => {
    const run = failingRun([spec('selftest.spec.ts', 'overflow goes red', [test_('selftest-touch', 'unexpected', "'Created' tab")])]);
    const r = build({ playwright: run, meta: { ...META, exitCode: 1 }, knownFailing: [KF, { ...KF, id: 'st', file: 'selftest.spec.ts', title: undefined, projects: undefined }] });
    expect(r.overall).toBe('fail');
  });

  it('lists a stale entry in the report as a note', () => {
    const r = build({ knownFailing: [KF] });
    expect(r.overall).toBe('pass');
    expect(r.staleKnownFailing).toEqual([KF.id]);
    expect(renderSweepMarkdown(r)).toMatch(/passed this run[\s\S]*jobs-filter-created-tab/);
  });

  it('shows the route-by-device cell as a known failure, worse than a pass', () => {
    const run = json([spec('gate.spec.ts', 'schedule', [test_('desktop', 'unexpected', 'scrollReach: the last control stays off screen'), test_('iphone-se', 'expected')])]);
    const rows = applyKnownFailing(flattenPlaywright(run), [{ id: 'g', file: 'gate.spec.ts', title: 'schedule', projects: ['desktop'], errorIncludes: 'scrollReach', reason: 'r', owner: 'o' }]).rows;
    expect(routeMatrix(rows).states[0]!.cells).toEqual({ desktop: 'known-failing', 'iphone-se': 'pass' });
  });
});

describe('a killed or silent run', () => {
  it('fails, and says so, when the Playwright process was killed by a signal', () => {
    const r = build({ meta: { ...META, exitCode: 1, signal: 'SIGKILL' } });
    expect(r.overall).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/killed by SIGKILL/);
  });

  it('fails, and says so, when no results were written at all', () => {
    const r = build({ playwright: null });
    expect(r.overall).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/wrote no results/);
  });

  it('carries the throwaway org the run left behind into the report', () => {
    const r = build({ meta: { ...META, leftoverOrg: 'org-123' } });
    expect(r.overall).toBe('fail');
    expect(r.problems.join(' ')).toMatch(/org-123/);
    expect(renderSweepMarkdown(r)).toMatch(/npm run test:mobile:teardown/);
  });
});

// ── teardown: log and retry ─────────────────────────────────────────────────────────────────────
describe('the throwaway-org teardown', () => {
  const noWait = async () => {};
  it('succeeds first time and clears the tax rates first', async () => {
    const calls: string[] = [];
    const r = await teardownWithRetries({
      deleteRates: async () => { calls.push('rates'); return { ok: true, deleted: 2 }; },
      teardownOrg: async () => { calls.push('org'); return { ok: true, status: 200, body: '{}' }; },
      sleep: noWait,
    });
    expect(r).toMatchObject({ ok: true, attempts: 1 });
    expect(calls).toEqual(['rates', 'org']);
  });

  it('retries after a 500 from the org purge, clearing the tax rates again each time, and succeeds', async () => {
    const calls: string[] = [];
    let n = 0;
    const log: string[] = [];
    const r = await teardownWithRetries({
      deleteRates: async () => { calls.push('rates'); return { ok: true, deleted: n === 1 ? 1 : 0 }; },
      teardownOrg: async () => { calls.push('org'); n += 1; return n < 2 ? { ok: false, status: 500, body: 'org_tax_rates_organization_id_fkey' } : { ok: true, status: 200, body: '{}' }; },
      log: (m: string) => log.push(m),
      sleep: noWait,
    });
    expect(r).toMatchObject({ ok: true, attempts: 2 });
    expect(calls).toEqual(['rates', 'org', 'rates', 'org']);
    expect(log.join('\n')).toMatch(/500[\s\S]*org_tax_rates_organization_id_fkey/);
  });

  it('says so, loudly, when the tax rates cannot be cleared (a failed login is not silent), and still tries the purge', async () => {
    const log: string[] = [];
    const r = await teardownWithRetries({
      deleteRates: async () => ({ ok: false, deleted: 0, reason: 'admin login answered 401' }),
      teardownOrg: async () => ({ ok: true, status: 200, body: '{}' }),
      log: (m: string) => log.push(m),
      sleep: noWait,
    });
    expect(r.ok).toBe(true);
    expect(log.join('\n')).toMatch(/could not clear the records the org purge cannot remove[\s\S]*admin login answered 401/);
  });

  it('gives up after the attempts, reports the last answer, and treats a thrown error as a failed attempt', async () => {
    let orgCalls = 0;
    const sleeps: number[] = [];
    const r = await teardownWithRetries({
      deleteRates: async () => { throw new Error('socket hang up'); },
      teardownOrg: async () => { orgCalls += 1; throw new Error('boom'); },
      attempts: 3,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    expect(r).toMatchObject({ ok: false, attempts: 3 });
    expect(r.body).toMatch(/boom/);
    expect(orgCalls).toBe(3);
    expect(sleeps).toHaveLength(2); // no wait after the last attempt
  });
});

// ── records the org purge cannot remove ─────────────────────────────────────────────────────────
describe('the records the throwaway-org purge cannot remove (a RESTRICT foreign key to the org)', () => {
  /** A fake API: rows per list path, a delete takes the row out, like the real one. */
  const fakeApi = (rows: Record<string, Array<{ id: string }>>, bodyKey: Record<string, string | null>) => {
    const deleted: string[] = [];
    return {
      deleted,
      get: async (path: string) => {
        const list = rows[path];
        if (!list) return { ok: () => false, status: () => 404, json: async () => ({}) };
        const key = bodyKey[path];
        return { ok: () => true, status: () => 200, json: async () => (key ? { [key]: [...list] } : [...list]) };
      },
      delete: async (path: string) => {
        const [listPath, id] = [Object.keys(rows).find((k) => path.startsWith(`${k}/`)), path.split('/').pop()];
        if (!listPath) return { ok: () => false, status: () => 404 };
        rows[listPath] = rows[listPath]!.filter((r) => r.id !== id);
        deleted.push(path);
        return { ok: () => true, status: () => 204 };
      },
    };
  };

  it('names the job sub-statuses the reorder-by-tap spec seeds, with the key the list answers under', () => {
    // org_id fkey job_sub_statuses_organization_id_fkey leaked the org on staging after slice 48 merged under slice 62.
    const blocker = PURGE_BLOCKERS.find((b: { listPath: string }) => b.listPath === '/api/job-sub-statuses');
    expect(blocker, 'job sub-statuses are a purge blocker').toBeDefined();
    expect(blocker!.deletePath('abc')).toBe('/api/job-sub-statuses/abc');
    expect(blocker!.ids({ job_sub_statuses: [{ id: 'a' }, { id: 'b' }] })).toEqual(['a', 'b']);
    expect(blocker!.ids({})).toEqual([]);
  });

  it('still names tax rates and vendors', () => {
    expect(PURGE_BLOCKERS.map((b: { listPath: string }) => b.listPath)).toEqual(
      expect.arrayContaining(['/api/org-tax-rates', '/api/inventory/vendors', '/api/job-sub-statuses']),
    );
  });

  it('deletes every record of every kind, including the job sub-statuses, and says ok', async () => {
    const rows = {
      '/api/org-tax-rates': [{ id: 'r1' }],
      '/api/inventory/vendors': [{ id: 'v1' }, { id: 'v2' }],
      '/api/job-sub-statuses': [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    };
    const api = fakeApi(rows, { '/api/org-tax-rates': null, '/api/inventory/vendors': 'vendors', '/api/job-sub-statuses': 'job_sub_statuses' });
    const r = await clearPurgeBlockers(api);
    expect(r).toEqual({ ok: true, deleted: 6 });
    expect(rows['/api/job-sub-statuses']).toEqual([]);
    expect(api.deleted).toContain('/api/job-sub-statuses/s2');
  });

  it('is not ok while a record remains (a delete that fails is reported, never swallowed)', async () => {
    const rows = { '/api/org-tax-rates': [], '/api/inventory/vendors': [], '/api/job-sub-statuses': [{ id: 's1' }] };
    const api = fakeApi(rows, { '/api/org-tax-rates': null, '/api/inventory/vendors': 'vendors', '/api/job-sub-statuses': 'job_sub_statuses' });
    api.delete = async () => ({ ok: () => false, status: () => 500 });
    const r = await clearPurgeBlockers(api);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/job sub-statuses[\s\S]*delete\(s\) failed|delete\(s\) failed/);
  });

  it('says why when a list cannot be read', async () => {
    const api = fakeApi({}, {});
    const r = await clearPurgeBlockers(api);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/listing the job sub-statuses answered 404/);
  });
});

// ── the gate measures the live app, whatever a developer's local env says ───────────────────────
describe('the gate pins the local-only dashboard mock off', () => {
  // frontend/.env.local (gitignored, and copied into a fresh worktree with the other env files)
  // may set VITE_DASHBOARD_USE_MOCK=true for the design-system preview. Vite lets .env.local into
  // every mode, so the gate's dev server served the static seed ($1,454,732 receivables) to the
  // 200%-text-size dashboard check and failed a promotion sweep for a figure no real org has.
  const config = readFileSync(join(FRONTEND, 'e2e/playwright.mobile.config.ts'), 'utf8');
  const sweep = readFileSync(join(FRONTEND, 'e2e/mobile/sweep.mjs'), 'utf8');

  it('sets it to false on the dev server (and the preview server) the gate starts', () => {
    expect(config.match(/VITE_DASHBOARD_USE_MOCK:\s*'false'/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('sets it to false for the sweep\'s production build too', () => {
    expect(sweep).toMatch(/VITE_DASHBOARD_USE_MOCK:\s*'false'/);
  });
});

// ── the promotion check ─────────────────────────────────────────────────────────────────────────
describe('the promotion check', () => {
  const NOW = Date.parse('2026-10-04T12:00:00.000Z');
  const sha = 'a'.repeat(40);
  const check = (report: unknown, over: Parameters<typeof checkSweepReport>[1] = {}) => checkSweepReport(report, { sha, now: NOW, ...over });

  it('accepts a fresh, passing, full report of the commit', () => {
    expect(check(build())).toEqual({ ok: true, problems: [] });
  });

  it('refuses when there is no report', () => {
    expect(check(null).ok).toBe(false);
    expect(check(null).problems[0]).toMatch(/run `npm run test:mobile:sweep`/);
  });

  it('refuses a failed report, with its reasons', () => {
    const r = check(build({ meta: { ...META, exitCode: 1 } }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/FAILED/);
  });

  it('refuses a report of another commit, accepts one that contains the promoted commit', () => {
    const other = 'b'.repeat(40);
    expect(check(build(), { sha: other }).problems.join(' ')).toMatch(/does not contain/);
    expect(check(build(), { sha: other, reportContainsSha: true }).ok).toBe(true);
    expect(check(build(), { sha: sha.slice(0, 9) }).ok).toBe(true);
  });

  it('refuses a report of an edited tree', () => {
    expect(check(build({ meta: { ...META, dirty: true } })).problems.join(' ')).toMatch(/uncommitted/);
  });

  it('refuses a stale report', () => {
    expect(check(build(), { now: NOW + 73 * 3_600_000 }).problems.join(' ')).toMatch(/h old/);
    expect(check(build(), { now: NOW + 73 * 3_600_000, maxAgeHours: 200 }).ok).toBe(true);
  });

  it('refuses a report that lacks a required device or a Lighthouse measurement', () => {
    const noFox = build();
    noFox.devices = noFox.devices.map((d) => (d.id === 'firefox' ? { ...d, ran: false } : d));
    expect(check(noFox).problems.join(' ')).toMatch(/did not run: firefox/);
    const noLh = build({ lighthouse: [] });
    expect(check(noLh).problems.join(' ')).toMatch(/no Lighthouse measurement for: public-estimate-open/);
  });

  it('needs a commit to check against', () => {
    expect(check(build(), { sha: undefined }).problems.join(' ')).toMatch(/--sha/);
  });
});

// ── the lists agree with the code ───────────────────────────────────────────────────────────────
describe('the sweep lists agree with the code', () => {
  it('requires exactly the six gate devices and the nine sweep devices', () => {
    expect([...REQUIRED_DEVICE_IDS].sort()).toEqual([...GATE_DEVICES, ...SWEEP_DEVICES].map((d) => d.id).sort());
  });

  it('covers the seven leftover devices the PRD names, plus the audit\'s Pixel 7 landscape and Fold cover', () => {
    const byId = Object.fromEntries(SWEEP_DEVICES.map((d) => [d.id, d]));
    expect(byId['iphone-17-pro-max']!.descriptor).toBe('iPhone 17 Pro Max'); // D4
    expect(byId['pixel-7']!.descriptor).toBe('Pixel 7'); // D5
    expect(byId['iphone-se-landscape']!.descriptor).toBe('iPhone SE landscape'); // D6, 568x320
    expect(byId['fold-unfolded']!.descriptor).toBe('Galaxy Z Fold 7'); // D10
    expect(byId['ipad-mini-landscape']!.descriptor).toBe('iPad Mini landscape'); // D12
    expect(byId['tab-s9']!.descriptor).toBe('Galaxy Tab S9'); // D13, 640 wide: exactly sm
    expect(byId['firefox']).toMatchObject({ descriptor: 'Desktop Firefox', viewport: { width: 360, height: 740 }, extra: { hasTouch: true } }); // D15
    expect(SWEEP_DEVICES.every((d) => d.touch)).toBe(true);
  });

  it('keeps the budget file at the rubric budget and on the three required pages', () => {
    const file = JSON.parse(readFileSync(join(FRONTEND, 'e2e/mobile/lighthouse-budget.json'), 'utf8'));
    expect(file.budget).toEqual(DEFAULT_BUDGET);
    expect(file.pages.map((p: { id: string }) => p.id).sort()).toEqual([...REQUIRED_LIGHTHOUSE_IDS].sort());
    for (const p of file.pages) expect(['enforce', 'report']).toContain(p.mode);
    // A page may be in report mode only while a named slice owns the fix (slice 61 for all three
    // today); a report-mode page with no owner is a budget nobody is working to meet.
    for (const p of file.pages.filter((x: { mode: string }) => x.mode === 'report')) {
      expect(p.owner, `${p.id} is report-only, so it names its owner`).toMatch(/^\d+$/);
      // ...and cannot get worse meanwhile: a ceiling above the target and a CLS ceiling no looser than it.
      expect(p.ceiling.lcpMs, `${p.id} has an LCP ceiling`).toBeGreaterThan(DEFAULT_BUDGET.lcpMs);
      expect(p.ceiling.cls, `${p.id} has a CLS ceiling`).toBeLessThanOrEqual(DEFAULT_BUDGET.cls);
    }
  });

  const fixtures = {
    organizationId: 'o', automationId: 'auto1', lighthouseTechEmail: 'e', lighthouseTechPassword: 'p', techId: 't', leadId: 'lead1', customerId: 'cus1', jobId: 'job1',
    estimateOpen: { id: 'est1', token: 'tok' }, estimateWon: { id: 'est2', token: 'tok' }, invoiceOpen: { id: 'inv1', token: 'tok' }, invoicePaid: { id: 'inv2', token: 'tok' },
  } satisfies GateFixtures;

  /** Every `path="/..."` the staff and public route tables declare, as regexes (`:param` is one segment). */
  const declared = (() => {
    const dir = join(FRONTEND, 'src/pages/v2/routes');
    const paths = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.routes.tsx'))) {
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/path="(\/[^"]*)"/g)) paths.add(m[1]!);
    }
    return [...paths].map((p) => new RegExp(`^${p.replace(/:[A-Za-z]+/g, '[^/]+')}$`));
  })();

  it('opens only routes the app declares', () => {
    const missing = SWEEP_STATES.map((s) => ({ id: s.id, path: new URL(s.path(fixtures), 'http://x').pathname })).filter((s) => !declared.some((re) => re.test(s.path)));
    expect(missing).toEqual([]);
  });

  it('opens every report page, and the audit\'s unswept routes', () => {
    const registry = readFileSync(join(FRONTEND, 'src/pages/v2/reports/reports-registry.ts'), 'utf8');
    const slugs = [...registry.matchAll(/^\s+'([a-z-]+)': lazy/gm)].map((m) => m[1]!).sort();
    expect(slugs).toHaveLength(23);
    expect([...SWEEP_REPORT_SLUGS, 'revenue', 'unpaid-invoices'].sort()).toEqual(slugs);
    const ids = new Set(ALL_STATES.map((s) => s.id));
    for (const id of ['lead-edit', 'customer-edit', 'estimate-version', 'job-statement', 'automation-detail', 'comm-phone-numbers', 'comm-text-settings', 'phone-tab', 'settings-branding', 'settings-decline-reasons', 'settings-email-sender', 'settings-inventory', 'settings-job-sub-statuses', 'settings-payments', 'settings-phone-sms', 'settings-security', 'accept-invite-form']) {
      expect(ids.has(id), `${id} is in the sweep`).toBe(true);
    }
    // Locations was added by slice 17 and profile was already a key route: not duplicated.
    expect(SWEEP_STATES.some((s) => KEY_STATES.some((k) => k.id === s.id))).toBe(false);
    expect(new Set(ALL_STATES.map((s) => s.id)).size).toBe(ALL_STATES.length);
  });

  it('keeps a slice\'s own run on the key routes, and runs the sweep-only routes only in the sweep or when asked', () => {
    expect(selectStates('', false)).toEqual(KEY_STATES);
    expect(selectStates('', true)).toEqual(ALL_STATES);
    expect(selectStates('settings*', false).some((s) => s.sweepOnly)).toBe(true); // asking by prefix includes them
    expect(selectStates('group:sweep', false).every((s) => s.sweepOnly)).toBe(true);
    expect(selectStates('group:sweep', false)).toHaveLength(SWEEP_STATES.length);
    expect(selectStates('report-activity', false).map((s) => s.id)).toEqual(['report-activity']);
    expect(() => selectStates('no-such-state', false)).toThrow(/unknown state/);
  });

  it('lists known-broken pages only for states the sweep opens, each with a reason', () => {
    const file = JSON.parse(readFileSync(join(FRONTEND, 'e2e/mobile/known-broken.json'), 'utf8')) as { entries: Record<string, { reason: string }> };
    const ids = new Set(ALL_STATES.map((s) => s.id));
    for (const [id, e] of Object.entries(file.entries)) {
      expect(ids.has(id), `${id} is a state the sweep opens`).toBe(true);
      expect(e.reason.length, `${id} says what breaks`).toBeGreaterThan(20);
    }
  });

  it('lists known-failing specs only for spec files that exist and devices that run them, each with the error, a reason and an owner', () => {
    const file = JSON.parse(readFileSync(join(FRONTEND, 'e2e/mobile/known-failing.json'), 'utf8')) as { entries: Array<{ id: string; file: string; title?: string; projects?: string[]; errorIncludes?: string; reason: string; owner: string }> };
    const specs = new Set(readdirSync(join(FRONTEND, 'e2e/mobile')).filter((f) => f.endsWith('.spec.ts')));
    const devices = new Set(REQUIRED_DEVICE_IDS);
    const ids = new Set<string>();
    for (const e of file.entries) {
      expect(ids.has(e.id), `${e.id} is listed twice`).toBe(false);
      ids.add(e.id);
      expect(specs.has(e.file), `${e.id}: ${e.file} is a spec in e2e/mobile`).toBe(true);
      expect((e.errorIncludes ?? '').length, `${e.id} pins the error text, so a different failure is not excused`).toBeGreaterThan(5);
      expect(e.reason.length, `${e.id} says what fails`).toBeGreaterThan(20);
      expect(e.owner.length, `${e.id} has an owner`).toBeGreaterThan(2);
      for (const p of e.projects ?? []) expect(devices.has(p), `${e.id}: ${p} is a matrix device`).toBe(true);
    }
  });

  it('shows the accept-invite form with a stubbed invite and never submits it', () => {
    const s = SWEEP_STATES.find((x) => x.id === 'accept-invite-form')!;
    expect(s.anon).toBe(true);
    expect(typeof s.prepare).toBe('function');
  });
});

// ── the promotion checklist names the run ───────────────────────────────────────────────────────
describe('the promotion checklist', () => {
  const parity = readFileSync(join(REPO, 'docs/promotion-parity-check.md'), 'utf8');
  const ship = readFileSync(join(REPO, '.claude/skills/ship-changes/SKILL.md'), 'utf8');
  const readme = readFileSync(join(FRONTEND, 'e2e/mobile/README.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

  it('requires the sweep report before a promotion to main, and says where the report is kept', () => {
    expect(parity).toMatch(/npm run test:mobile:sweep\b/);
    expect(parity).toMatch(/npm run test:mobile:sweep:check/);
    expect(parity).toMatch(/e2e\/test-results-mobile\/sweep\/latest\.md/);
    expect(parity).toMatch(/do not (open|promote)/i);
  });

  it('is pointed to from the ship-to-main steps', () => {
    expect(ship).toMatch(/test:mobile:sweep:check/);
    expect(ship).toMatch(/promotion-parity-check\.md/);
  });

  it('is documented where the gate is', () => {
    expect(readme).toMatch(/## The full sweep/);
    expect(readme).toMatch(/test:mobile:sweep/);
    expect(readme).toMatch(/lighthouse-budget\.json/);
  });

  it('has its scripts, and a pinned Lighthouse', () => {
    for (const s of ['test:mobile:sweep', 'test:mobile:sweep:check', 'test:mobile:lighthouse', 'test:mobile:lighthouse:selftest']) expect(pkg.scripts[s], s).toBeTruthy();
    expect(pkg.devDependencies.lighthouse).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
