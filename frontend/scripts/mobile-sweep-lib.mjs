/**
 * The pure half of the full mobile sweep (mobile slice 62): the Lighthouse budget decision, the
 * sweep report, and the promotion check that reads it. No browser, no network, no git here, so
 * `src/__tests__/mobile-sweep.test.ts` can provoke every verdict with small fake inputs.
 *
 * The drivers are `e2e/mobile/sweep.mjs` (runs the sweep and writes the report),
 * `e2e/mobile/sweep-check.mjs` (the promotion check) and `e2e/mobile/lighthouse.spec.ts`
 * (measures the pages). Documentation: e2e/mobile/README.md, "The full sweep".
 */

/** PERF-03: Lighthouse mobile, largest contentful paint at most 2.5 s, layout shift at most 0.1. */
export const DEFAULT_BUDGET = { lcpMs: 2500, cls: 0.1 };

/** The matrix devices the full sweep must have run (ids as in e2e/mobile/devices.ts). */
export const REQUIRED_DEVICE_IDS = [
  'iphone-se', 'galaxy-s24', 'iphone-15', 'landscape-phone', 'ipad-mini', 'desktop',
  'iphone-17-pro-max', 'pixel-7', 'iphone-se-landscape', 'pixel-7-landscape', 'fold-cover',
  'fold-unfolded', 'ipad-mini-landscape', 'tab-s9', 'firefox',
];

/** The pages Lighthouse must have measured: the public pages and the technician landing page. */
export const REQUIRED_LIGHTHOUSE_IDS = ['public-estimate-open', 'public-invoice-open', 'technician-landing'];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The numbers the budget cares about, from one Lighthouse result (`lhr`). Null when the run failed. */
export function extractMetrics(lhr) {
  const a = lhr?.audits;
  const num = (id) => (Number.isFinite(a?.[id]?.numericValue) ? a[id].numericValue : null);
  const lcpMs = num('largest-contentful-paint');
  const cls = num('cumulative-layout-shift');
  if (lcpMs === null || cls === null) return null;
  return {
    lcpMs,
    cls,
    fcpMs: num('first-contentful-paint'),
    tbtMs: num('total-blocking-time'),
    bytes: num('total-byte-weight'),
    performanceScore: typeof lhr.categories?.performance?.score === 'number' ? lhr.categories.performance.score : null,
  };
}

/** The median of each metric over several runs (Lighthouse varies run to run; the median is what is judged). */
export function medianMetrics(runs) {
  const ok = runs.filter(Boolean);
  if (ok.length === 0) return null;
  const pick = (k) => {
    const xs = ok.map((r) => r[k]).filter((x) => typeof x === 'number');
    return xs.length ? median(xs) : null;
  };
  return { lcpMs: pick('lcpMs'), cls: pick('cls'), fcpMs: pick('fcpMs'), tbtMs: pick('tbtMs'), bytes: pick('bytes'), performanceScore: pick('performanceScore'), runs: ok.length };
}

/**
 * Judge one page's measured numbers against the budget. A page that could not be measured fails:
 * a budget nobody could read is not a pass.
 */
export function evaluateBudget(measured, budget = DEFAULT_BUDGET) {
  if (!measured || !Number.isFinite(measured.lcpMs) || !Number.isFinite(measured.cls)) {
    return { ok: false, failures: ['no Lighthouse result: the page could not be measured'] };
  }
  const failures = [];
  if (measured.lcpMs > budget.lcpMs) failures.push(`LCP ${(measured.lcpMs / 1000).toFixed(2)} s is over the ${(budget.lcpMs / 1000).toFixed(1)} s budget`);
  if (measured.cls > budget.cls) failures.push(`CLS ${measured.cls.toFixed(3)} is over the ${budget.cls} budget`);
  return { ok: failures.length === 0, failures };
}

/**
 * The result a page's `mode` makes of a measurement. `enforce` fails the run on a miss. `report`
 * prints the miss and passes: a known offender with an owner. A report-mode page may also carry a
 * `ceiling` (its measured state when it was listed, plus headroom for run-to-run noise): a page
 * over its ceiling FAILS even in report mode, so a page that is already over the target cannot get
 * worse while the owning slice works on it. The ceiling is what "tighten, never loosen" ratchets.
 */
export function lighthouseVerdict(page, measured, budget = DEFAULT_BUDGET) {
  const target = evaluateBudget(measured, { ...budget, ...(page.budget ?? {}) });
  if (target.ok) return { status: 'pass', failures: [] };
  if (page.mode !== 'report') return { status: 'fail', failures: target.failures };
  if (page.ceiling && measured) {
    const over = [];
    if (Number.isFinite(page.ceiling.lcpMs) && measured.lcpMs > page.ceiling.lcpMs) over.push(`LCP ${(measured.lcpMs / 1000).toFixed(2)} s is over this page's ceiling of ${(page.ceiling.lcpMs / 1000).toFixed(1)} s (it was ${(page.ceiling.lcpMs / 1000).toFixed(1)} s or better when it was listed)`);
    if (Number.isFinite(page.ceiling.cls) && measured.cls > page.ceiling.cls) over.push(`CLS ${measured.cls.toFixed(3)} is over this page's ceiling of ${page.ceiling.cls}`);
    if (over.length) return { status: 'fail', failures: over };
  }
  return { status: 'report', failures: target.failures };
}

// ── the Playwright JSON, flattened ──────────────────────────────────────────────────────────────

/** One row per (spec, project): `{ file, title, project, status, error }`. `status`: pass|fail|flaky|skipped. */
export function flattenPlaywright(json) {
  const rows = [];
  const walk = (suite, file) => {
    const f = suite.file || file;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const results = t.results ?? [];
        const last = results[results.length - 1];
        let status;
        if ((t.annotations ?? []).some((a) => a.type === 'known broken') || (last?.annotations ?? []).some((a) => a.type === 'known broken')) status = 'known';
        else if (t.status === 'skipped' || (last && last.status === 'skipped')) status = 'skipped';
        else if (t.status === 'flaky') status = 'flaky';
        else if (t.status === 'expected') status = 'pass';
        else status = 'fail';
        const err = status === 'fail' ? (last?.error?.message ?? results.find((r) => r.error)?.error?.message ?? '') : '';
        rows.push({ file: spec.file || f || '', title: spec.title, project: t.projectName, status, error: String(err).replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 600) });
      }
    }
    for (const s of suite.suites ?? []) walk(s, f);
  };
  for (const s of json?.suites ?? []) walk(s, s.file);
  return rows;
}

/** A gate.spec.ts test title is `<state id>` or `<state id> (overlay: <kind>)`; the state id is the key. */
export const stateIdOf = (title) => title.replace(/ \(overlay: .*\)$/, '').trim();

const STATUS_RANK = { fail: 5, 'known-failing': 4, known: 3, flaky: 2, pass: 1, skipped: 0 };

/**
 * The route x device matrix from the gate's own tests (gate.spec.ts): `{ states: [{id, cells: {device: status}}], devices }`.
 * A cell is pass, fail, flaky, skipped (the overlay does not exist at that width) or absent (not run).
 */
export function routeMatrix(rows) {
  const gate = rows.filter((r) => /(^|\/)gate\.spec\.ts$/.test(r.file));
  const byState = new Map();
  for (const r of gate) {
    const id = stateIdOf(r.title);
    const cells = byState.get(id) ?? {};
    const prev = cells[r.project];
    if (!prev || STATUS_RANK[r.status] > STATUS_RANK[prev]) cells[r.project] = r.status;
    byState.set(id, cells);
  }
  const devices = [...new Set(gate.map((r) => r.project))];
  return { states: [...byState].map(([id, cells]) => ({ id, cells })), devices };
}

// ── known-failing targeted specs ────────────────────────────────────────────────────────────────

/**
 * Failures that were already there, recorded so one stale spec does not block every promotion
 * forever (`e2e/mobile/known-failing.json`). A failing row becomes `known-failing` only when an
 * entry matches ALL of: the spec file, the title (when the entry has one), the device project
 * (when it lists any) and a piece of the error text. A failure on another device, in another test,
 * or with another message is a NEW failure and stays red. An entry that matched nothing is `stale`:
 * its spec passes now, so the entry is deleted (reported, not failed: a spec that fails only some
 * runs would otherwise turn the whole sweep red on the runs where it happens to pass).
 * @returns {{ rows: object[], matched: Record<string, number>, stale: string[] }}
 */
export function applyKnownFailing(rows, entries = []) {
  const matched = Object.fromEntries(entries.map((e) => [e.id, 0]));
  const base = (f) => String(f || '').split('/').pop();
  const out = rows.map((r) => {
    // A self-test must stay able to fail the run, and the Lighthouse budget has its own verdict.
    if (r.status !== 'fail' || /^selftest/.test(r.project) || r.project === 'lighthouse') return r;
    const e = entries.find(
      (x) =>
        base(r.file) === x.file &&
        (x.title == null || r.title === x.title) &&
        (!x.projects || x.projects.length === 0 || x.projects.includes(r.project)) &&
        (!x.errorIncludes || String(r.error).includes(x.errorIncludes)),
    );
    if (!e) return r;
    matched[e.id] += 1;
    return { ...r, status: 'known-failing', knownFailingId: e.id };
  });
  return { rows: out, matched, stale: entries.filter((e) => matched[e.id] === 0).map((e) => e.id) };
}

// ── the report ──────────────────────────────────────────────────────────────────────────────────

/**
 * Build the report object.
 * @param {object} i
 * @param {object} i.meta        { startedAt, finishedAt, commit, stagingSha, branch, dirty, command, exitCode, signal, leftoverOrg, node }
 * @param {object[]} [i.knownFailing] entries of known-failing.json: failures recorded as already there (see applyKnownFailing)
 * @param {object} i.playwright  the Playwright JSON reporter's output (or null when the run never started)
 * @param {object[]} i.devices   [{ id, matrix, viewport, engine }] every device the sweep is meant to run
 * @param {string[]} i.expectedStates every state id the sweep is meant to open
 * @param {object[]} i.lighthouse [{ id, label, mode, measured, verdict }]
 * @param {object} [i.records]   { reportPairs: number, byCheck: {check: number} } known offenders still on the allow-list
 * @param {object} [i.build]     { ok, publicBundleOk } the production build the Lighthouse run measured
 */
export function buildSweepReport(i) {
  const flat = flattenPlaywright(i.playwright);
  const kf = applyKnownFailing(flat, i.knownFailing ?? []);
  const rows = kf.rows;
  const matrix = routeMatrix(rows);
  const ranDevices = new Set(rows.map((r) => r.project));
  const deviceRows = i.devices.map((d) => {
    const mine = rows.filter((r) => r.project === d.id);
    const count = (s) => mine.filter((r) => r.status === s).length;
    return { ...d, ran: ranDevices.has(d.id), tests: mine.length, pass: count('pass'), fail: count('fail'), flaky: count('flaky'), skipped: count('skipped'), known: count('known'), knownFailing: count('known-failing') };
  });
  const seenStates = new Set(matrix.states.map((s) => s.id));
  const missingStates = i.expectedStates.filter((id) => !seenStates.has(id));
  // A state is "not run on a device" when the device ran the gate at all but has no cell for it.
  const gap = [];
  for (const d of deviceRows.filter((x) => x.ran)) {
    for (const s of matrix.states) if (!(d.id in s.cells)) gap.push({ state: s.id, device: d.id });
  }
  const failures = rows.filter((r) => r.status === 'fail' && !/^selftest/.test(r.project) && r.project !== 'lighthouse').map((r) => ({ project: r.project, file: r.file, title: r.title, error: r.error }));
  const entryById = new Map((i.knownFailing ?? []).map((e) => [e.id, e]));
  const knownFailing = rows
    .filter((r) => r.status === 'known-failing' && !/^selftest/.test(r.project))
    .map((r) => ({ id: r.knownFailingId, project: r.project, file: r.file, title: r.title, error: r.error, owner: entryById.get(r.knownFailingId)?.owner ?? '', reason: entryById.get(r.knownFailingId)?.reason ?? '' }));
  const selftestFailures = rows.filter((r) => r.status === 'fail' && /^selftest/.test(r.project)).map((r) => ({ project: r.project, title: r.title, error: r.error }));
  const specs = new Map();
  for (const r of rows.filter((x) => !/^selftest/.test(x.project))) {
    const s = specs.get(r.file) ?? { file: r.file, pass: 0, fail: 0, flaky: 0, skipped: 0, knownFailing: 0 };
    s[r.status === 'known-failing' ? 'knownFailing' : r.status] += 1;
    specs.set(r.file, s);
  }
  // Pages that crash today and are listed in known-broken.json: reported everywhere, never hidden.
  const knownBroken = [...new Set(rows.filter((r) => r.status === 'known' && /(^|\/)gate\.spec\.ts$/.test(r.file)).map((r) => stateIdOf(r.title)))].sort();
  const lighthouse = i.lighthouse ?? [];
  const lhFail = lighthouse.filter((p) => p.verdict?.status === 'fail');
  const lhMissing = REQUIRED_LIGHTHOUSE_IDS.filter((id) => !lighthouse.some((p) => p.id === id));
  const notRun = deviceRows.filter((d) => !d.ran).map((d) => d.id);

  const problems = [];
  if (i.meta.partial) problems.push('this was a PARTIAL run (a route or project filter, or --skip-build): only a full sweep counts for a promotion');
  if (i.meta.signal) problems.push(`the Playwright run was killed by ${i.meta.signal}: the results are incomplete and the throwaway org may be left behind (npm run test:mobile:teardown)`);
  if (!i.playwright) problems.push('the Playwright run wrote no results (the reporter never finished): the run was cut short');
  // Playwright exits 1 when any test fails, including a recorded known-failing one. That alone is
  // explained; an exit with nothing failing at all, or with a failure that is not recorded, is not.
  const exitExplained = knownFailing.length > 0 && failures.length === 0 && selftestFailures.length === 0 && !rows.some((r) => r.status === 'fail');
  if (i.meta.exitCode !== 0 && !exitExplained && !i.meta.signal && i.playwright) problems.push(`the Playwright run exited ${i.meta.exitCode}`);
  if (i.meta.leftoverOrg) problems.push(`the throwaway org ${i.meta.leftoverOrg} could not be torn down and is still on the staging database: run \`npm run test:mobile:teardown\` (or hand the id to whoever cleans up)`);
  if (i.build && i.build.ok === false) problems.push('the production build failed');
  if (notRun.length) problems.push(`devices that did not run: ${notRun.join(', ')}`);
  if (missingStates.length) problems.push(`states that did not run on any device: ${missingStates.join(', ')}`);
  if (gap.length) problems.push(`${gap.length} state/device pair(s) did not run`);
  if (failures.length) problems.push(`${failures.length} failing test(s)`);
  if (selftestFailures.length) problems.push(`${selftestFailures.length} failing self-test(s): a check that cannot be shown red is not trusted`);
  if (lhMissing.length) problems.push(`Lighthouse did not measure: ${lhMissing.join(', ')}`);
  if (lhFail.length) problems.push(`${lhFail.length} page(s) over the Lighthouse budget`);

  return {
    version: 1,
    overall: problems.length === 0 ? 'pass' : 'fail',
    problems,
    meta: i.meta,
    build: i.build ?? null,
    devices: deviceRows,
    notRunDevices: notRun,
    routes: { expected: i.expectedStates.length, ran: matrix.states.length, missing: missingStates, gap },
    matrix,
    knownBroken,
    failures,
    knownFailing,
    staleKnownFailing: kf.stale,
    selftestFailures,
    specs: [...specs.values()].sort((a, b) => a.file.localeCompare(b.file)),
    lighthouse,
    records: i.records ?? null,
  };
}

const sym = { pass: 'ok', fail: 'FAIL', 'known-failing': 'KNOWN FAIL', flaky: 'flaky', skipped: 'n/a', known: 'BROKEN' };

/** The report as the Markdown a person (and the promotion PR) reads. */
export function renderSweepMarkdown(r) {
  const L = [];
  const m = r.meta;
  L.push(`# Mobile sweep report: ${r.overall.toUpperCase()}`);
  L.push('');
  L.push(`- Commit swept: \`${m.commit}\`${m.dirty ? ' (**working tree had uncommitted changes**)' : ''} on \`${m.branch}\``);
  L.push(`- Staging head when it started: \`${m.stagingSha}\``);
  L.push(`- Started ${m.startedAt}, finished ${m.finishedAt} (${Math.round((Date.parse(m.finishedAt) - Date.parse(m.startedAt)) / 60000)} min)`);
  L.push(`- Command: \`${m.command}\`, exit code ${m.exitCode}`);
  L.push(`- Runs against the staging database in a throwaway org; not CI; no real device (see the real-device checklist, \`docs/qa/real-device-release-checklist.md\`).`);
  L.push('');
  if (r.problems.length) {
    L.push('## Why it failed');
    L.push('');
    for (const p of r.problems) L.push(`- ${p}`);
    if (m.leftoverOrg || m.signal || r.problems.some((p) => /wrote no results/.test(p))) L.push('\nTo remove a throwaway org a cut-short run left on the staging database: `npm run test:mobile:teardown` (from `frontend/`).');
    L.push('');
  }
  L.push('## Devices');
  L.push('');
  L.push('| Matrix | Project | Viewport | Engine | Ran | Pass | Fail | Known fail | Flaky | N/A | Broken |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const d of r.devices) L.push(`| ${d.matrix ?? ''} | ${d.id} | ${d.viewport ?? ''} | ${d.engine ?? ''} | ${d.ran ? 'yes' : '**NO**'} | ${d.pass} | ${d.fail} | ${d.knownFailing ?? 0} | ${d.flaky} | ${d.skipped} | ${d.known ?? 0} |`);
  L.push('');
  L.push('Not in this list on purpose: D14 (Moto G4 at 4x CPU) is the Lighthouse run below, which uses that emulation.');
  L.push('');
  L.push('## Routes');
  L.push('');
  L.push(`${r.routes.ran} of ${r.routes.expected} states opened (key routes, their overlays, and the sweep-only routes from the audit's unswept list).`);
  if (r.routes.missing.length) L.push(`\n**Did not run on any device:** ${r.routes.missing.join(', ')}`);
  if (r.routes.gap.length) L.push(`\n**Did not run on some devices:** ${r.routes.gap.slice(0, 40).map((g) => `${g.state}@${g.device}`).join(', ')}${r.routes.gap.length > 40 ? ', ...' : ''}`);
  L.push('');
  L.push('### Route by device');
  L.push('');
  const devs = r.matrix.devices;
  L.push(`| State | ${devs.join(' | ')} |`);
  L.push(`|---|${devs.map(() => '---').join('|')}|`);
  for (const s of r.matrix.states) L.push(`| ${s.id} | ${devs.map((d) => (d in s.cells ? sym[s.cells[d]] : '-')).join(' | ')} |`);
  L.push('');
  L.push('`ok` passed, `FAIL` failed, `KNOWN FAIL` failed the way `e2e/mobile/known-failing.json` records, `flaky` passed on retry, `n/a` skipped (the overlay does not exist at that width), `-` did not run.');
  L.push('');
  if (r.knownBroken?.length) {
    L.push('## Known broken pages');
    L.push('');
    L.push(`These pages show the app's error screen for the throwaway org. They are listed in \`e2e/mobile/known-broken.json\`, so they do not fail the sweep, but they are product defects, not test noise: ${r.knownBroken.join(', ')}. The fix deletes the entry.`);
    L.push('');
  }
  if (r.failures.length) {
    L.push('## Failures');
    L.push('');
    for (const f of r.failures) L.push(`- **${f.project}** ${f.title} (${f.file.split('/').pop()}): ${f.error}`);
    L.push('');
  }
  if (r.knownFailing?.length) {
    L.push('## Known failing specs');
    L.push('');
    L.push('These specs failed the way `e2e/mobile/known-failing.json` records, on a base that has nothing to do with this sweep, so they do not fail it. Each has an owner; the fix deletes its entry. A failure on another device or with another message is NOT covered and fails the sweep.');
    L.push('');
    for (const f of r.knownFailing) L.push(`- **${f.project}** ${f.title} (${f.file.split('/').pop()}, entry \`${f.id}\`, owner ${f.owner || 'none'}): ${f.error}`);
    L.push('');
  }
  if (r.staleKnownFailing?.length) {
    L.push('## Known-failing entries that passed this run');
    L.push('');
    L.push(`Delete these from \`e2e/mobile/known-failing.json\` if they pass again on the next sweep: ${r.staleKnownFailing.join(', ')}.`);
    L.push('');
  }
  if (r.selftestFailures.length) {
    L.push('## Self-test failures');
    L.push('');
    for (const f of r.selftestFailures) L.push(`- **${f.project}** ${f.title}: ${f.error}`);
    L.push('');
  }
  L.push('## Lighthouse (mobile, budget: LCP at most 2.5 s, CLS at most 0.1)');
  L.push('');
  L.push('Production build served by `vite preview`; Lighthouse mobile defaults (4x CPU slowdown, slow 4G). Median of the runs. `REPORT` is a miss on a page not yet enforced: the named slice owns the fix and flips the page to `enforce` in `lighthouse-budget.json`.');
  L.push('');
  L.push('| Page | Mode | Runs | LCP | CLS | FCP | TBT | Verdict |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const p of r.lighthouse) {
    const x = p.measured;
    const s = (v, f) => (typeof v === 'number' ? f(v) : '-');
    L.push(`| ${p.label ?? p.id} | ${p.mode} | ${x?.runs ?? 0} | ${s(x?.lcpMs, (v) => `${(v / 1000).toFixed(2)} s`)} | ${s(x?.cls, (v) => v.toFixed(3))} | ${s(x?.fcpMs, (v) => `${(v / 1000).toFixed(2)} s`)} | ${s(x?.tbtMs, (v) => `${Math.round(v)} ms`)} | ${p.verdict?.status === 'pass' ? 'ok' : `${(p.verdict?.status ?? 'none').toUpperCase()}${p.owner ? ` (slice ${p.owner})` : ''}: ${(p.verdict?.failures ?? []).join('; ')}`} |`);
  }
  L.push('');
  L.push('## Test files');
  L.push('');
  L.push('| File | Pass | Fail | Known fail | Flaky | Skipped |');
  L.push('|---|---|---|---|---|---|');
  for (const s of r.specs) L.push(`| ${s.file.split('/').pop()} | ${s.pass} | ${s.fail} | ${s.knownFailing ?? 0} | ${s.flaky} | ${s.skipped} |`);
  L.push('');
  if (r.records) {
    L.push('## Known offenders still on the allow-list');
    L.push('');
    L.push(`${r.records.reportPairs} route/check/device pair(s) were measured as known report-mode offenders (they do not fail the run; each belongs to a later slice).`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}

// ── the promotion check ─────────────────────────────────────────────────────────────────────────

/**
 * Whether a sweep report allows a promotion to main of `sha` (the staging commit or head being
 * promoted). Returns `{ ok, problems }`. `reportContainsSha` is the caller's `git merge-base
 * --is-ancestor <sha> <swept commit>`, so a sweep of a LATER staging head covers an earlier commit.
 * Rules: the report passed; it swept that commit or one that contains it; the tree it
 * swept was clean; every required device and Lighthouse page is in it; it is not stale.
 */
export function checkSweepReport(report, { sha, now = Date.now(), maxAgeHours = 72, reportContainsSha } = {}) {
  const problems = [];
  if (!report || report.version !== 1) return { ok: false, problems: ['no sweep report (or an unreadable one): run `npm run test:mobile:sweep` in frontend/'] };
  if (report.overall !== 'pass') problems.push(`the sweep report FAILED (${(report.problems ?? []).join('; ') || 'no reason recorded'})`);
  const swept = report.meta?.commit ?? '';
  if (!sha) problems.push('no commit to check against: pass --sha <the staging head being promoted>');
  else if (!swept || !(swept === sha || swept.startsWith(sha) || sha.startsWith(swept) || reportContainsSha === true)) problems.push(`the report swept ${swept || 'an unknown commit'}, which does not contain ${sha}: run the sweep again on the commit being promoted`);
  if (report.meta?.dirty) problems.push('the swept working tree had uncommitted changes, so the report does not describe a commit');
  const ran = new Set((report.devices ?? []).filter((d) => d.ran).map((d) => d.id));
  const missingDevices = REQUIRED_DEVICE_IDS.filter((id) => !ran.has(id));
  if (missingDevices.length) problems.push(`the report did not run: ${missingDevices.join(', ')}`);
  const lh = new Set((report.lighthouse ?? []).filter((p) => p.measured).map((p) => p.id));
  const missingLh = REQUIRED_LIGHTHOUSE_IDS.filter((id) => !lh.has(id));
  if (missingLh.length) problems.push(`the report has no Lighthouse measurement for: ${missingLh.join(', ')}`);
  const finished = Date.parse(report.meta?.finishedAt ?? '');
  if (!Number.isFinite(finished)) problems.push('the report has no finish time');
  else if (now - finished > maxAgeHours * 3_600_000) problems.push(`the report is ${Math.round((now - finished) / 3_600_000)} h old (limit ${maxAgeHours} h): run the sweep again`);
  return { ok: problems.length === 0, problems };
}

// ── the throwaway-org teardown: log and retry ───────────────────────────────────────────────────

/**
 * Records a spec (or the seed) can leave in the throwaway org that the org purge cannot remove:
 * their tables have a RESTRICT foreign key to the org (the purge's known #1027 gap, see
 * PURGE_EXEMPT in backend/src/lib/purge.ts), so the whole teardown rolls back with P2003 and the
 * run leaves its org on staging. Each is deleted through its own API first. `ids` returns the
 * rows' ids from the list response body. When a new spec makes records of another #1027 model,
 * the first teardown log names the constraint (`<table>_organization_id_fkey`): add the model here.
 */
export const PURGE_BLOCKERS = [
  {
    label: 'tax rates',
    listPath: '/api/org-tax-rates',
    deletePath: (id) => `/api/org-tax-rates/${id}`,
    ids: (b) => (Array.isArray(b) ? b : b?.rates ?? b?.taxRates ?? b?.items ?? []).map((r) => r.id),
  },
  {
    label: 'vendors', // legacy-modal.spec.ts creates "Gate vendor" (slice 53)
    listPath: '/api/inventory/vendors',
    deletePath: (id) => `/api/inventory/vendors/${id}`,
    ids: (b) => (Array.isArray(b) ? b : b?.vendors ?? []).map((r) => r.id),
  },
  {
    label: 'job sub-statuses', // reorder-by-tap.spec.ts creates "Gate sub A/B/C" (slice 48)
    listPath: '/api/job-sub-statuses',
    deletePath: (id) => `/api/job-sub-statuses/${id}`,
    ids: (b) => (Array.isArray(b) ? b : b?.job_sub_statuses ?? []).map((r) => r.id),
  },
];

/**
 * Delete what the org purge cannot (PURGE_BLOCKERS), through an authenticated API as the
 * throwaway admin. `api` is anything shaped like Playwright's request context: `get(path)` and
 * `delete(path)` answering `{ ok(), status() }` (and `json()` on a get). A fake in the tests.
 *
 * Says why when it cannot finish and never reports ok while a record remains.
 * @param {{get: (p: string) => Promise<any>, delete: (p: string) => Promise<any>}} api
 * @param {typeof PURGE_BLOCKERS} [blockers]
 * @returns {Promise<{ok: boolean, deleted: number, reason?: string}>}
 */
export async function clearPurgeBlockers(api, blockers = PURGE_BLOCKERS) {
  let deleted = 0;
  const problems = [];
  for (const blocker of blockers) {
    let failed = 0;
    // Up to three passes: a list can be paged, and a delete can race a spec that is still writing.
    for (let pass = 0; pass < 3; pass += 1) {
      const list = await api.get(blocker.listPath);
      if (!list.ok()) {
        problems.push(`listing the ${blocker.label} answered ${list.status()}`);
        break;
      }
      const ids = blocker.ids(await list.json().catch(() => ({})));
      if (ids.length === 0) break;
      if (pass === 2) {
        problems.push(`${blocker.label} were still being created after three passes`);
        break;
      }
      for (const id of ids) {
        const res = await api.delete(blocker.deletePath(id));
        if (res.ok()) deleted += 1;
        else failed += 1;
      }
    }
    if (failed) problems.push(`${failed} ${blocker.label} delete(s) failed`);
  }
  return problems.length ? { ok: false, deleted, reason: problems.join('; ') } : { ok: true, deleted };
}

/**
 * Tear the throwaway org down, retrying. The org purge cannot delete an org that still has tax
 * rates (a RESTRICT foreign key), so every attempt first clears them again: a sweep whose specs
 * created extra rates, or a first attempt whose admin login failed quietly, no longer leaves the
 * org on the staging database. Nothing is silent: each attempt says what it did and what it got.
 * The drivers are injected so this stays pure (the real ones are in e2e/mobile/mobile-teardown.ts).
 * @param {object} d
 * @param {() => Promise<{ok: boolean, deleted?: number, reason?: string}>} d.deleteRates
 * @param {() => Promise<{ok: boolean, status: number, body: string}>} d.teardownOrg
 * @param {(msg: string) => void} [d.log]
 * @returns {Promise<{ok: boolean, attempts: number, status?: number, body?: string}>}
 */
export async function teardownWithRetries({ deleteRates, teardownOrg, log = () => {}, attempts = 3, backoffMs = 5000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last = { status: 0, body: '' };
  for (let n = 1; n <= attempts; n += 1) {
    let rates;
    try {
      rates = await deleteRates();
    } catch (err) {
      rates = { ok: false, deleted: 0, reason: String(err) };
    }
    if (!rates.ok) log(`attempt ${n}/${attempts}: could not clear the records the org purge cannot remove (tax rates, vendors, job sub-statuses) (${rates.reason ?? 'unknown reason'}); the org purge may fail on them`);
    else if (rates.deleted) log(`attempt ${n}/${attempts}: deleted ${rates.deleted} record(s) the purge cannot remove`);
    let res;
    try {
      res = await teardownOrg();
    } catch (err) {
      res = { ok: false, status: 0, body: String(err) };
    }
    last = res;
    if (res.ok) return { ok: true, attempts: n };
    log(`attempt ${n}/${attempts}: the org teardown answered ${res.status} ${String(res.body).slice(0, 1200)}`);
    if (n < attempts) await sleep(backoffMs * n);
  }
  return { ok: false, attempts, status: last.status, body: last.body };
}
