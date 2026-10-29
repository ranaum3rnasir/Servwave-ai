/* =============================================================================
   EstimateStatus rename guard - no bare APPROVED/CANCELLED on the Estimate surface.

   2026-07-20 rename (closure-plan D1 / port-plan section 4 M1 + 8.4):
   EstimateStatus APPROVED -> WON, CANCELLED -> ARCHIVED. This guards against the
   rename silently regressing (port-plan section 11's top risk: a missed consumer
   read-filter matches nothing and fails with zero error).

   PREVIOUSLY A CI JOB. This was 60 lines of shell in .github/workflows/ci.yml
   that paid a full runner slot - checkout, job setup, and (at the time) an npm
   cache post-step - to run a 2-second grep. It is a static scan of source files,
   which is what a test is, so it lives here with the ~20 other filesystem
   guards in this directory. Moving it also means it runs locally before you
   push instead of only after.

   --- scope ------------------------------------------------------------------
   Files under backend/src and frontend/src whose PATH names them as
   estimate-owned (contains "estimate", case-insensitive). Tests, __tests__ and
   _mock fixtures are excluded - they legitimately exercise the old values.

   The pattern only matches a QUOTED literal, so it never trips on prose
   comments or doc narration (which reference the word unquoted, e.g. "APPROVED
   is the freeze line").

   --- legitimate non-EstimateStatus uses, excluded ---------------------------
   Even within estimate-owned files, two patterns are genuinely not about
   EstimateStatus:

     - Lead terminal-status arrays, e.g. ['WON','LOST','CANCELLED'] - several
       estimate-controller transitions also flip the parent Lead. Detected by
       co-occurrence with 'LOST', a LeadStatus-only value never used by
       EstimateStatus.

     - TimelineEvent.event_type: 'APPROVED'/'CANCELLED' - a free-text history
       label (schema: `event_type String`, not enum-backed), decoupled from
       EstimateStatus by design; renaming it is a copy decision, not a
       correctness one.

   --- deliberately NOT covered ------------------------------------------------
   A handful of controllers/services mix real Estimate-status logic with other
   entities in the SAME file (job.controller.ts, invoice.controller.ts,
   customer.controller.ts, dashboard.controller.ts, webhook.controller.ts,
   report.controller.ts, leads-report.ts, automations/stopIf.ts,
   copilot/toolRegistry.ts, ui/status-badge.tsx, layout/search-shared.tsx) - a
   blanket scan of those would false-positive on Job/Lead's own legitimate
   'CANCELLED' or PunchReview's 'APPROVED'. Those were hand-audited in the
   2026-07-20 rename sweep; their Estimate.status Prisma writes/reads are
   enum-typed, so a reintroduced 'APPROVED'/'CANCELLED' there already fails
   `tsc` in the build. This guard is the narrow, zero-false-positive complement
   for the dedicated Estimate surface, including its non-Prisma-typed spots -
   raw SQL, zod enums, plain string compares.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative, sep } from 'path';

// backend/src/__tests__ -> repo root
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCAN_ROOTS = [join('backend', 'src'), join('frontend', 'src')];

const SCANNED_EXTENSIONS = ['.ts', '.tsx'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '__tests__', '_mock']);

/** A quoted pre-rename literal: 'APPROVED', "CANCELLED", etc. */
const PRE_RENAME_LITERAL = /['"](APPROVED|CANCELLED)['"]/;
/** LeadStatus terminal arrays - LOST is LeadStatus-only, never EstimateStatus. */
const LEAD_TERMINAL_ARRAY = /LOST/;
/** TimelineEvent.event_type is free-text history, not the enum. */
const TIMELINE_EVENT_TYPE = /event_type:\s*['"](APPROVED|CANCELLED)['"]/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (SCANNED_EXTENSIONS.some((e) => full.endsWith(e)) && !full.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

function estimateOwnedFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(REPO_ROOT, root);
    if (!existsSync(abs)) {
      throw new Error(
        `Scan root ${root} not found at ${abs}. This guard resolves the repo root ` +
          `relative to its own location; if the test file moved, fix REPO_ROOT.`,
      );
    }
    for (const file of walk(abs)) {
      const rel = relative(REPO_ROOT, file).split(sep).join('/');
      if (rel.toLowerCase().includes('estimate')) files.push(file);
    }
  }
  return files;
}

/** Returns "path:line: text" for every offending line in the file. */
export function findPreRenameLiterals(absPath: string, relPath: string): string[] {
  const findings: string[] = [];
  const lines = readFileSync(absPath, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!PRE_RENAME_LITERAL.test(line)) return;
    if (LEAD_TERMINAL_ARRAY.test(line)) return;
    if (TIMELINE_EVENT_TYPE.test(line)) return;
    findings.push(`${relPath}:${i + 1}: ${line.trim()}`);
  });
  return findings;
}

describe('EstimateStatus rename guard (APPROVED -> WON, CANCELLED -> ARCHIVED)', () => {
  const files = estimateOwnedFiles();

  // Every assertion below iterates this list. If the path matching ever breaks,
  // the guard would pass vacuously over zero files - green, and blind. Assert
  // the list is populated so that failure mode is loud instead.
  it('finds the estimate-owned surface to scan', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('has no bare pre-rename EstimateStatus literals', () => {
    const findings = files.flatMap((f) =>
      findPreRenameLiterals(f, relative(REPO_ROOT, f).split(sep).join('/')),
    );

    expect(
      findings,
      findings.length === 0
        ? ''
        : `APPROVED/CANCELLED are no longer valid EstimateStatus values - renamed to\n` +
            `WON/ARCHIVED on 2026-07-20. Use the typed ESTIMATE_STATUS constant\n` +
            `(backend/src/constants/estimateStatus.ts or frontend/src/constants/estimateStatus.ts),\n` +
            `never a bare string literal.\n\n${findings.join('\n')}`,
    ).toEqual([]);
  });
});
