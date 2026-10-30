/* =============================================================================
   Roles & Permissions alignment, P5 and P7: who made a record opens nothing by itself.

   A guard over the source. The creator rule is gone: View is the single gate and Their own is attached plus the
   documents made for a customer alone, so no route may admit a person because they made the record, and the module
   that did is deleted. A new guard of that kind is a change to the principles, to be made in review, not a way to
   make this test pass.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Names of the creator-based guards and helpers that used to exist. */
const CREATOR_GUARDS = /\b(canDoOrCreator|canDoOrLeadCreator|canDoAnyOrLeadCreator|creatorRuleOpens|creatorCanOpen|isCreatorStillAttached|creatorReach|createdAndAttachedReach|withCreatorRule)\b/;

describe('no creator-based guard (P7)', () => {
  it('has no creator rule module', () => {
    expect(existsSync(join(ROOT, 'src/lib/permissions/creatorRule.ts'))).toBe(false);
  });

  it('has no non-test source that guards, filters or answers by who made a record', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, 'src'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
        if (CREATOR_GUARDS.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}: ${code}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('answers a record outside the reach as not found on the estimate and invoice detail reads', () => {
    for (const [file, notFound] of [
      ['src/controllers/estimate.controller.ts', "'Estimate not found'"],
      ['src/controllers/invoice.controller.ts', "'Invoice not found'"],
    ] as const) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const start = source.indexOf('export async function getById');
      const body = source.slice(start, source.indexOf('\n}\n', start));
      expect(body, file).toContain(notFound);
      expect(body, file).not.toMatch(/status\(403\)/);
    }
  });
});
