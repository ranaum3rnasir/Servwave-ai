/**
 * The Lighthouse mobile budget (mobile slice 62, rubric PERF-03): LCP at most 2.5 s and CLS at
 * most 0.1 on the public estimate and invoice pages and on the technician landing page.
 *
 * It measures the PRODUCTION build served by `vite preview` (the sweep script builds it; on its
 * own: `npx vite build`, then `MOBILE_GATE_LIGHTHOUSE=1 npm run test:mobile -- --project=lighthouse`),
 * proxied to the same doored API and throwaway org as the rest of the gate. The numbers go to
 * `test-results-mobile/lighthouse/<page id>.json` for the sweep report; a page over budget in
 * `enforce` mode fails its test, one in `report` mode prints the miss and passes.
 *
 * The technician page signs in as its own technician (never the gate's shared admin): a measured
 * browser that gets signed out then revokes only that user's sessions.
 */
import { expect, request, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measurePage } from './lighthouse-run';
import { ALL_STATES, type GateFixtures } from './routes';
import { FIXTURES_FILE, gateBackend } from './paths';
import { authStorageKey } from './session';
import { lighthouseVerdict, type LighthousePage } from '../../scripts/mobile-sweep-lib.mjs';

type BudgetPage = LighthousePage & { state?: string; path?: string; signedIn?: boolean; owner?: string };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const budgetFile = JSON.parse(fs.readFileSync(path.join(HERE, 'lighthouse-budget.json'), 'utf8')) as {
  budget: { lcpMs: number; cls: number };
  runs: number;
  pages: BudgetPage[];
};
const pages = budgetFile.pages;
const OUT_DIR = path.resolve(HERE, '..', 'test-results-mobile', 'lighthouse');
const previewUrl = () => {
  const u = process.env.MOBILE_GATE_PREVIEW_URL;
  if (!u) throw new Error('MOBILE_GATE_PREVIEW_URL is unset: run through e2e/playwright.mobile.config.ts');
  return u;
};

test.setTimeout(30 * 60_000);
test.describe.configure({ retries: 0 }); // a miss is the answer; measuring all three pages again would only double the wait

/**
 * One test, every page, in turn: Lighthouse measures CPU-bound work, so two at once would lend
 * each other noise, and a miss on one page must not stop the others being measured. Each page's
 * result is written as it finishes; the misses are asserted together at the end.
 */
test('lighthouse budget: the public pages and the technician landing page', async ({}, testInfo) => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fixtures: GateFixtures = JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
  const base = previewUrl();
  const misses: string[] = [];

  for (const page of pages) {
    let urlPath: string;
    if (page.state) {
      const state = ALL_STATES.find((s) => s.id === page.state);
      if (!state) throw new Error(`lighthouse-budget.json names an unknown state: ${page.state}`);
      urlPath = state.path(fixtures);
    } else {
      urlPath = page.path!;
    }

    let session: { origin: string; key: string; value: string } | undefined;
    if (page.signedIn) {
      const api = await request.newContext({ baseURL: gateBackend() });
      const res = await api.post('/api/auth/login', { data: { email: fixtures.lighthouseTechEmail, password: fixtures.lighthouseTechPassword } });
      const body = await res.json().catch(() => ({}));
      await api.dispose();
      expect(res.ok(), `the Lighthouse technician could not sign in: ${res.status()} ${body.error ?? ''}`).toBe(true);
      session = { origin: base, key: authStorageKey(), value: JSON.stringify(body.session) };
    }

    const { measured } = await measurePage({ url: `${base}${urlPath}`, session }, budgetFile.runs);
    const verdict = lighthouseVerdict(page, measured, budgetFile.budget);
    const record = { id: page.id, label: page.label, mode: page.mode, owner: page.owner, measured, verdict };
    fs.writeFileSync(path.join(OUT_DIR, `${page.id}.json`), JSON.stringify(record, null, 1));
    await testInfo.attach(`lighthouse-${page.id}.json`, { body: JSON.stringify(record, null, 1), contentType: 'application/json' });
    console.log(`[lighthouse] ${page.id}: ${verdict.status.toUpperCase()} ${JSON.stringify(measured)}${verdict.failures.length ? ` - ${verdict.failures.join('; ')}` : ''}`);

    if (verdict.status === 'report') testInfo.annotations.push({ type: 'report lighthouse', description: `${page.id}: ${verdict.failures.join('; ')}` });
    if (verdict.status === 'fail') misses.push(`${page.id}: ${verdict.failures.join('; ')}`);
  }

  expect(misses, 'Lighthouse budget misses on enforced pages').toEqual([]);
});
