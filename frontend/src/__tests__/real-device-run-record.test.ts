import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

/**
 * Real-device run record guard (mobile slice 73, rubric TEST-07).
 *
 * The first run on hardware is a person's job (Ran's), but the sheet they run from and the record
 * they fill in must stay honest as the checklist grows:
 *
 *   - every RD-NN row of the checklist has exactly one line in the run record's results table;
 *   - nobody but the tester can mark a row passed: a row is "to be run by Ran", "pending" (its
 *     owning slice has not landed), "n.a." or, once the run happened, "pass" or "fail";
 *   - a "fail" names a follow-up (F73-n) that the record defines;
 *   - every piece of emulation evidence a row cites (E1, E2, ...) is defined, with the command that
 *     produced it;
 *   - the run sheet says what the person must do, with what, and where results go.
 *
 * The record is a local planning document next to the checklist; it is not published.
 */

const REPO_ROOT = path.resolve(__dirname, '../../..');
const QA_DIR = path.join(REPO_ROOT, 'md_files/specs/qa');
const CHECKLIST = path.join(QA_DIR, 'real-device-release-checklist.md');
const RECORD = path.join(QA_DIR, 'real-device-run-01.md');

const read = (file: string) => readFileSync(file, 'utf8');

/** The markdown under one `## Heading`, up to the next `## `. */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`\n## ${heading}`);
  if (start === -1) return '';
  const rest = doc.slice(start + 4 + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());

const RESULT = /^(to be run by Ran|pending|n\.a\.|pass|fail)\b/;

describe('real-device run record (slice 73)', () => {
  it('exists next to the checklist', () => {
    expect(existsSync(RECORD), `${RECORD} is missing`).toBe(true);
  });

  const doc = existsSync(RECORD) ? read(RECORD) : '';
  const checklistIds = [...section(read(CHECKLIST), 'Items').matchAll(/^\|\s*(RD-\d{2})\s*\|/gm)].map((m) => m[1]);
  const rows = section(doc, 'Results')
    .split('\n')
    .filter((l) => /^\|\s*RD-\d{2}\s*\|/.test(l))
    .map(cells);

  it('has one results line for every checklist row, in order, and none for a row that is gone', () => {
    expect(checklistIds.length).toBeGreaterThan(0);
    expect(rows.map((r) => r[0])).toEqual(checklistIds);
  });

  it('gives each row an allowed real-device result; only the tester may write pass or fail', () => {
    for (const r of rows) {
      const [id, , , , realDevice] = r;
      expect(realDevice, `${id}: real-device result "${realDevice}"`).toMatch(RESULT);
    }
  });

  it('names a defined follow-up for every failed row', () => {
    const followUps = new Set([...section(doc, 'Follow-ups').matchAll(/^\|\s*(F73-\d+)\s*\|/gm)].map((m) => m[1]));
    for (const r of rows) {
      const [id, , , emulation, realDevice] = r;
      const cited = `${emulation} ${realDevice}`.match(/F73-\d+/g) ?? [];
      for (const f of cited) expect(followUps.has(f), `${id} cites ${f}, which the Follow-ups table does not define`).toBe(true);
      if (/^fail\b/.test(realDevice)) expect(cited.length, `${id} failed without a follow-up`).toBeGreaterThan(0);
    }
  });

  it('defines every piece of emulation evidence a row cites, with its command', () => {
    const evidence = new Map(
      section(doc, 'Emulation evidence')
        .split('\n')
        .filter((l) => /^\|\s*E\d+\s*\|/.test(l))
        .map((l) => {
          const c = cells(l);
          return [c[0], c.join(' ')] as const;
        }),
    );
    expect(evidence.size).toBeGreaterThan(0);
    for (const [id, text] of evidence) expect(text, `${id} names no command`).toMatch(/`[^`]+`/);
    for (const r of rows) {
      for (const e of r[3].match(/\bE\d+\b/g) ?? []) {
        expect(evidence.has(e), `${r[0]} cites ${e}, which Emulation evidence does not define`).toBe(true);
      }
    }
  });

  it('tells the tester what to bring, what to do and where to record it', () => {
    for (const heading of ['What Ran must do', 'Devices and browsers', 'Accounts', 'Routes', 'Recording the run']) {
      expect(section(doc, heading).trim().length, `section "${heading}" is missing or empty`).toBeGreaterThan(40);
    }
  });

  it('carries no vendor name in text a person reads off the screen (the sheet is internal, but the quoted copy is not)', () => {
    // The sheet quotes what the app shows (toast text, button names). None may be a vendor name.
    for (const term of ['CallTrackingMetrics', 'Supabase']) expect(doc).not.toContain(term);
  });
});
