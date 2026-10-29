/**
 * Mobile slice 74 (rubric TEST-06, story 148): the phone visual baselines.
 *
 * The comparison itself is a Playwright run on macOS (`npm run test:mobile:visual`), not a unit
 * test; what runs here is the guard that keeps its parts in step so the gate cannot quietly stop
 * covering something:
 *   - every screen on the list has its committed photograph on every one of the three phones, and
 *     no committed photograph belongs to a screen or phone that is no longer on the list;
 *   - the list itself is sound (unique ids, three phones, the 320 and 393 portraits and one
 *     landscape, paths that build);
 *   - the run's scripts exist, the config writes where the guard looks, and the promotion
 *     checklist names the baseline run beside the full sweep.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { GATE_DEVICES } from '../../e2e/mobile/devices';
import {
  VISUAL_DEVICES,
  VISUAL_STATES,
  baselineFile,
  baselineName,
  isWholePage,
  requiredBaseline,
  type VisualFixtures,
} from '../../e2e/mobile/visual-states';

const FRONTEND = resolve(__dirname, '../..');
const REPO = resolve(FRONTEND, '..');
const BASELINES = join(FRONTEND, 'e2e', 'visual-baselines', 'phone');

const FIXTURES: VisualFixtures = {
  organizationId: 'org',
  customerId: 'cust',
  leadId: 'lead',
  estimateOpen: { id: 'est', token: 'a b' },
  invoiceOpen: { id: 'inv', token: 'c&d' },
  jobId: 'job',
  automationId: 'auto',
};

const files = existsSync(BASELINES) ? readdirSync(BASELINES) : [];

describe('the list of photographed screens', () => {
  it('has unique ids', () => {
    const ids = VISUAL_STATES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers the screens of the four slices it was blocked on (28, 55, 65 and 69)', () => {
    const slices = new Set(VISUAL_STATES.map((s) => s.slice));
    for (const slice of ['28', '55', '65', '69']) expect(slices, `a screen from slice ${slice}`).toContain(slice);
  });

  it('names an overlay state as its page, a tilde and the overlay', () => {
    for (const s of VISUAL_STATES.filter((x) => x.overlay)) expect(s.id.endsWith(`~${s.overlay}`), s.id).toBe(true);
  });

  it('builds a path for every screen, with the public links carrying their token', () => {
    for (const s of VISUAL_STATES) {
      const path = s.path(FIXTURES);
      expect(path.startsWith('/'), s.id).toBe(true);
      if (s.anon) expect(path, s.id).toMatch(/^\/p\/(estimates|invoices)\/[^?]+\?token=[^&]+$/);
    }
    expect(VISUAL_STATES.find((s) => s.id === 'public-invoice-open')!.path(FIXTURES)).toBe('/p/invoices/inv?token=c%26d');
  });
});

describe('the three phones', () => {
  it('are device projects of the mobile gate', () => {
    const gate = new Set(GATE_DEVICES.map((d) => d.id));
    for (const d of VISUAL_DEVICES) expect(gate, d.id).toContain(d.id);
  });

  it('are the narrowest phone, a common one and one landscape size', () => {
    expect(VISUAL_DEVICES.map((d) => d.id)).toEqual(['iphone-se', 'iphone-15', 'landscape-phone']);
    expect(VISUAL_DEVICES.map((d) => d.kind)).toEqual(['portrait', 'portrait', 'landscape']);
  });
});

describe('the committed photographs', () => {
  it('has one for every screen on every phone', () => {
    const missing: string[] = [];
    for (const s of VISUAL_STATES) {
      for (const d of VISUAL_DEVICES) {
        const f = requiredBaseline(s, d);
        if (!files.includes(f)) missing.push(f);
      }
    }
    expect(missing, `missing baselines (run \`npm run test:mobile:visual:update\` on macOS and review the PNGs):\n${missing.join('\n')}`).toEqual([]);
  });

  it('has none for a screen or phone that is no longer on the list', () => {
    const known = new Set<string>();
    for (const s of VISUAL_STATES) {
      for (const d of VISUAL_DEVICES) for (const part of ['whole', 'top', 'end'] as const) known.add(baselineFile(baselineName(s, part), d.id));
    }
    const orphans = files.filter((f) => !known.has(f));
    expect(orphans, `orphaned baselines, delete them:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('names its platform, so a Linux run can never be compared against macOS pixels', () => {
    for (const f of files) expect(f, f).toMatch(/-darwin\.png$/);
  });

  it('gives a portrait phone a whole-page photograph (an overlay or a bounded page its real-size screen) and a landscape phone a first-screen one', () => {
    for (const s of VISUAL_STATES.filter(isWholePage)) {
      expect(files, s.id).toContain(baselineFile(baselineName(s, 'whole'), 'iphone-se'));
      expect(files, s.id).toContain(baselineFile(baselineName(s, 'whole'), 'iphone-15'));
      expect(files, s.id).toContain(baselineFile(baselineName(s, 'top'), 'landscape-phone'));
    }
  });
});

describe('the run', () => {
  const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('has its two scripts, both on the baseline config', () => {
    expect(pkg.scripts['test:mobile:visual']).toBe('playwright test --config=e2e/playwright.mobile-visual.config.ts');
    expect(pkg.scripts['test:mobile:visual:update']).toBe('playwright test --config=e2e/playwright.mobile-visual.config.ts --update-snapshots');
    expect(existsSync(join(FRONTEND, 'e2e', 'playwright.mobile-visual.config.ts'))).toBe(true);
  });

  it('writes its photographs where this guard and the committed folder look', () => {
    const config = readFileSync(join(FRONTEND, 'e2e', 'playwright.mobile-visual.config.ts'), 'utf8');
    expect(config).toContain("snapshotPathTemplate: '{testDir}/../visual-baselines/phone/{arg}-{projectName}-{platform}{ext}'");
    expect(config, 'no retry may hide a flaky baseline').toMatch(/retries: 0/);
  });

  it('keeps the self-test that makes the comparison go red on a moved layout', () => {
    const spec = readFileSync(join(FRONTEND, 'e2e', 'mobile', 'phone-visual.spec.ts'), 'utf8');
    expect(spec).toContain('selftest: a deliberate layout change fails the comparison');
    expect(spec, 'the self-test must never run while baselines are re-recorded, or it would overwrite one').toMatch(/updateSnapshots === 'all'/);
  });

  it('is named in the promotion checklist beside the full sweep', () => {
    const doc = readFileSync(join(REPO, 'docs', 'promotion-parity-check.md'), 'utf8');
    const axis5 = doc.slice(doc.indexOf('## Axis 5'));
    expect(axis5).toContain('npm run test:mobile:sweep');
    expect(axis5, 'axis 5 names the phone baseline run').toContain('npm run test:mobile:visual');
  });

  it('is documented in the gate README', () => {
    const readme = readFileSync(join(FRONTEND, 'e2e', 'mobile', 'README.md'), 'utf8');
    expect(readme).toContain('npm run test:mobile:visual');
    expect(readme).toContain('visual-baselines/phone');
  });
});
