import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Real-device release checklist guard (mobile slice 10, rubric TEST-07).
 *
 * Emulation cannot show the on-screen keyboard, the notch, the Home Screen app
 * or in-app browsers, so those items live on a written checklist that a person
 * runs on hardware before a release. This guard keeps that document honest:
 *
 *   - it exists next to the QA briefing;
 *   - it names every browser and device the PRD's Testing Decisions list;
 *   - every device-only rubric item has a row, and every row carries a rubric
 *     ID and the slice that owns it (later slices append rows in this shape);
 *   - the QA briefing points at it, not at the retired technician app.
 *
 * Geometry is not tested here; that is the mobile Playwright gate's job.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const QA_DIR = path.join(REPO_ROOT, 'md_files/specs/qa');
const CHECKLIST_FILE = 'real-device-release-checklist.md';
const CHECKLIST = path.join(QA_DIR, CHECKLIST_FILE);
const BRIEFING = path.join(QA_DIR, 'qa-briefing.md');

/** The PRD's "device-only items still to verify on hardware". */
const DEVICE_ONLY_RUBRIC_IDS = [
  'VP-02',
  'VP-03',
  'VP-04',
  'VP-06',
  'KB-06',
  'KB-07',
  'KB-09',
  'TOUCH-09',
  'TOUCH-12',
  'CMP-06',
  'CMP-14',
  'CMP-15',
  'CMP-16',
  'PUB-01',
  'PUB-02',
  'PWA-02',
  'PWA-06',
  'A11Y-01',
  'A11Y-08',
];

/** The PRD's browser list, as the phrase each must appear under. */
const BROWSERS = [
  'iOS Safari in a tab',
  'iOS Safari from the Home Screen',
  'Chrome on iOS',
  'Chrome on Android',
  'Samsung Internet',
  'forced dark mode',
  'Firefox on Android',
  'in-app browser from an SMS link',
  'in-app browser from an email-app link',
  'in-app browser from a social-app direct message',
  'iPadOS Safari with its desktop user agent',
];

const DEVICES = [
  'small iPhone (SE class)',
  'current iPhone with a Dynamic Island',
  'Galaxy A-series',
  'Pixel',
  'iPad',
];

const RUBRIC_ID = /\b(?:VP|SCR|KB|TOUCH|CMP|PUB|PWA|PERF|A11Y|TEST)-\d{2}\b/g;
const SLICE_COUNT = 75;

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** The markdown under one `## Heading`, up to the next `## `. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}\n`);
  if (start === -1) return '';
  const rest = doc.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

interface ItemRow {
  id: string;
  rubric: string[];
  owners: number[];
  check: string;
  where: string;
  passWhen: string;
}

/** Rows of the Items table: `| RD-NN | rubric | owner slices | check | where | pass when |`. */
function itemRows(doc: string): ItemRow[] {
  return section(doc, 'Items')
    .split('\n')
    .filter((line) => /^\|\s*RD-\d{2}\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim());
      const [id, rubric = '', owner = '', check = '', where = '', passWhen = ''] = cells;
      return {
        id,
        rubric: rubric.match(RUBRIC_ID) ?? [],
        owners: (owner.match(/\b\d{1,2}\b/g) ?? []).map(Number),
        check,
        where,
        passWhen,
      };
    });
}

describe('real-device release checklist (TEST-07)', () => {
  it('exists next to the QA briefing', () => {
    expect(existsSync(CHECKLIST)).toBe(true);
  });

  describe('contents', () => {
    const doc = existsSync(CHECKLIST) ? read(CHECKLIST) : '';
    const rows = itemRows(doc);

    it('lists every browser the PRD names', () => {
      const browsers = section(doc, 'Browsers');
      const missing = BROWSERS.filter((b) => !browsers.includes(b));
      expect(missing).toEqual([]);
    });

    it('lists every device the PRD names', () => {
      const devices = section(doc, 'Devices');
      const missing = DEVICES.filter((d) => !devices.includes(d));
      expect(missing).toEqual([]);
    });

    it('has a row for every device-only rubric item', () => {
      const covered = new Set(rows.flatMap((r) => r.rubric));
      const missing = DEVICE_ONLY_RUBRIC_IDS.filter((id) => !covered.has(id));
      expect(missing).toEqual([]);
    });

    it('covers the user-agent families emulation cannot reproduce', () => {
      const uaRow = rows.find((r) => r.check.includes('Chrome on iOS') && r.check.includes('iPadOS'));
      expect(uaRow, 'a row for Chrome on iOS and the iPadOS desktop user agent').toBeDefined();
    });

    it('tags every row with a rubric ID and an owning slice, and fills every column', () => {
      expect(rows.length).toBeGreaterThan(0);
      const bad = rows.filter(
        (r) =>
          r.rubric.length === 0 ||
          r.owners.length === 0 ||
          r.owners.some((n) => n < 1 || n > SLICE_COUNT) ||
          !r.check ||
          !r.where ||
          !r.passWhen,
      );
      expect(bad.map((r) => r.id)).toEqual([]);
    });

    it('gives every row a unique ID', () => {
      const ids = rows.map((r) => r.id);
      expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    });
  });

  describe('QA briefing', () => {
    const briefing = read(BRIEFING);

    it('points at the checklist', () => {
      expect(briefing).toContain(`](${CHECKLIST_FILE})`);
    });

    it('no longer sends real-device testing to the retired technician app', () => {
      const realDeviceLines = briefing.split('\n').filter((l) => /real[ -]device/i.test(l));
      expect(realDeviceLines.length).toBeGreaterThan(0);
      expect(realDeviceLines.filter((l) => l.includes('/tech'))).toEqual([]);
    });
  });
});
