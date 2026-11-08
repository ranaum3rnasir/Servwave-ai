/**
 * #2041 R4 — a source-scanning guard, not a per-site integration test.
 *
 * `can(req, 'read', 'Customer', row)` is `req.ability.can(...)`, which THROWS on OWN_CUSTOMER's
 * nested to-one -> to-many arms (`enforce.ts:246-256`). The fix converts every one of the eight
 * sites (`customerContact.ts`, `customer-duplicate.ts`, `lead.controller.ts`, `job.controller.ts`,
 * `estimate.controller.ts` x2, `invoice.controller.ts` x2) to the SQL-backed, synchronous
 * `matchesFragment`/`isCustomerReadableRow`/`canReadCustomerById` verdict instead — none of which
 * can throw on a well-formed condition (pinned directly by `customer-scope-helper.test.ts`'s R12
 * cases). This guard asserts the structural half of that fix: no call site in the backend still
 * asks CASL a per-row Customer question, so the throw this amendment warned about cannot recur.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('#2041 R4 — no remaining CASL per-row Customer check', () => {
  it('no `can(req, \'read\', \'Customer\', …)` (or subject(\'Customer\', …)) call site exists anywhere in src/', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of allTsFiles(root)) {
      // Comment lines (`//` or a `*` continuation) are allowed to name the OLD call shape while
      // explaining the conversion — only real code lines are offenders.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      if (/can\(\s*req\s*,\s*['"]read['"]\s*,\s*['"]Customer['"]/.test(code)) {
        offenders.push(file);
      }
      if (/subject\(\s*['"]Customer['"]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
