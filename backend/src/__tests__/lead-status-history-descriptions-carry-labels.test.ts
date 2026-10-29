/**
 * Every History sentence written for a lead status move reads the on-screen label, never the raw
 * enum value (walkthrough lead-statuses PRD 11.2 and 12.6: "No raw value ... appears anywhere on
 * screen, in exports, or in History").
 *
 * `transitionLeadStatus` is the one writer of lead status History rows, so this reads the
 * `description` each of its callers hands it. The sentences are built inside controllers that need
 * a full request to reach (estimate send, void, correction, deposit webhooks), and several of
 * those doors have no test that drives them; scanning the call sites is what covers all of them,
 * and a new door is covered the day it is written.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LeadStatus } from '@prisma/client';
import { LEAD_STATUS_LABEL } from '../services/lead-stage.service';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') ? [full] : [];
  });
}

/** The `description:` expression of every `transitionLeadStatus(tx, { ... })` call in a file. */
function descriptionsOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const call = /transitionLeadStatus\(\s*tx\s*,\s*\{/g;
  for (let m = call.exec(text); m; m = call.exec(text)) {
    const rest = text.slice(m.index);
    // The options object ends at its first line holding only the closing `});`.
    const end = rest.search(/\n\s*\}\);/);
    const block = rest.slice(0, end);
    const d = block.match(/description:\s*([\s\S]*?),\s*\n\s*(?:metadata|data|notFrom|onlyFrom|actorId|from|to|leadId|orgId)\b/);
    if (d) out.push(d[1]);
  }
  return out;
}

const RAW = [...Object.values(LeadStatus), 'estimated'];
const rawIn = (expr: string) =>
  // Template placeholders are code, not copy; what is left is the literal wording.
  RAW.filter((v) => new RegExp(`\\b${v}\\b`).test(expr.replace(/\$\{[^}]*\}/g, '')));

describe('lead status History descriptions', () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith('lead-stage.service.ts'));
  const found = files.flatMap((f) => descriptionsOf(f).map((d) => ({ file: path.relative(SRC, f), d })));

  it('finds the transition call sites it is meant to guard', () => {
    // 11 doors outside the service today; a scanner that matched nothing would pass vacuously.
    expect(found.length).toBeGreaterThanOrEqual(11);
  });

  it('writes no raw status value as literal wording at any call site', () => {
    const offenders = found.filter(({ d }) => rawIn(d).length > 0).map(({ file, d }) => `${file}: ${d.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('never interpolates the bare status into a sentence; only the label', () => {
    const offenders = found
      .filter(({ d }) => /\$\{\s*(?:to|from|status|existing\.status|statusChange)\s*\}/.test(d) || /\.toLowerCase\(\)/.test(d))
      .map(({ file, d }) => `${file}: ${d.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('has a label for every status, and none is the raw value', () => {
    for (const s of Object.values(LeadStatus)) {
      expect(LEAD_STATUS_LABEL[s]).toBeTruthy();
      expect(LEAD_STATUS_LABEL[s]).not.toBe(s);
    }
  });
});
