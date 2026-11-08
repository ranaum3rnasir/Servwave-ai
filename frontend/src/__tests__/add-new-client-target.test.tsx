/**
 * #1472 - static pins that back up `repro-1472.test.tsx` (the behavioural check) for the two
 * surfaces that suite cannot reach on its own.
 *
 * AC2 (sidebar `+` -> New Estimate, S2): `sidebarCreateMenu.test.tsx` deliberately `vi.mock`s
 * `newEstimateDialog` down to an open-aware stub, so nothing in that suite can exercise
 * `handleAddNewClient`. What S2 actually ADDS on top of S1 is the wiring - SidebarCreateMenu
 * renders the same fixed v2 dialog - so that wiring is what gets pinned here, and AC1's
 * behavioural coverage (in `repro-1472.test.tsx`) carries the rest.
 *
 * AC4 sub-check 2 (round-trip, static fallback): `EstimatesPage.tsx`'s `?newCustomerId=`
 * consumption is untouched by this fix (this PR only repoints the two `navigate()` calls that
 * SEND a client there), so it is pinned by source inspection rather than rendered - that page
 * mounts a DataTable and several queries with no existing render harness, and fighting one for
 * code this fix does not touch is out of scope per the spec's Test plan.
 *
 * AC5 (repo-wide guard): after the fix, exactly one `'/leads/new'` literal disappears from each
 * dialog file (both `handleAddNewClient` sites), and the `leads/new?customer_id` targets used by
 * the sibling `handleCreateLead` are untouched. Counts below are asserted programmatically
 * against the CURRENT (fixed) tree - the base-branch counts are recorded in the spec.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_DIR = join(__dirname, '..');
// This file itself talks ABOUT the two grep patterns below in prose (docblock and test
// titles), which would otherwise self-match and inflate the count it is trying to pin.
const SELF = relative(SRC_DIR, __filename);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every `{file, line}` under `src/` (excluding this file) whose line matches `pattern`. */
function grepLines(pattern: RegExp): { file: string; line: string }[] {
  const hits: { file: string; line: string }[] = [];
  for (const file of walk(SRC_DIR)) {
    const relFile = relative(SRC_DIR, file);
    if (relFile === SELF) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (pattern.test(line)) hits.push({ file: relFile, line });
    }
  }
  return hits;
}

function read(relPath: string): string {
  return readFileSync(join(SRC_DIR, relPath), 'utf8');
}

describe('#1472 - "Add new client" -> /customers/new, static pins', () => {
  it('AC2: SidebarCreateMenu still imports and renders the FIXED v2 newEstimateDialog', () => {
    const src = read('pages/v2/SidebarCreateMenu.tsx');
    expect(src).toMatch(
      /import\s*\{\s*NewEstimateDialog\s*\}\s*from\s*'@\/pages\/v2\/estimates\/components\/newEstimateDialog'/,
    );
    expect(src).toMatch(/<NewEstimateDialog\b/);
  });

  it('AC4 sub-check 2: EstimatesPage still consumes ?newCustomerId= into preSelectedCustomerId and strips the param', () => {
    const src = read('pages/v2/estimates/EstimatesPage.tsx');
    expect(src).toContain("searchParams.get('newCustomerId')");
    expect(src).toMatch(/setPreSelectedCustomerId\(newCustomerId\)/);
    expect(src).toMatch(/setShowNewDialog\(true\)/);
    expect(src).toMatch(/searchParams\.delete\('newCustomerId'\)/);
    expect(src).toMatch(/preSelectedCustomerId=\{preSelectedCustomerId\}/);
  });

  it('AC5: neither handleAddNewClient site still targets \'/leads/new\' - both moved to /customers/new', () => {
    const dialogFiles = [
      'pages/v2/estimates/components/newEstimateDialog.tsx',
      'components/estimates/NewEstimateDialog.tsx',
    ];
    for (const relPath of dialogFiles) {
      const src = read(relPath);
      const handlerBody = src.slice(src.indexOf('function handleAddNewClient'), src.indexOf('function handleAddNewClient') + 300);
      expect(handlerBody).not.toMatch(/'\/leads\/new'/);
      expect(handlerBody).toMatch(/'\/customers\/new'/);
    }
  });

  it('AC5 repo-wide guard: exactly 11 lines under src/ still reference the \'/leads/new\' literal, and none of them are in either dialog', () => {
    const matches = grepLines(/'\/leads\/new'/);
    expect(matches).toHaveLength(11);
    const dialogHits = matches.filter(
      (m) => m.file === 'pages/v2/estimates/components/newEstimateDialog.tsx'
        || m.file === 'components/estimates/NewEstimateDialog.tsx',
    );
    expect(dialogHits).toHaveLength(0);
  });

  it('AC5 control: "leads/new?customer_id" (handleCreateLead\'s target, plus customer-detail affordances) is unchanged by this fix', () => {
    const matches = grepLines(/leads\/new\?customer_id/);
    expect(matches).toHaveLength(8);
    // Both dialogs' handleCreateLead sites are among them - proving that handler is untouched.
    expect(matches.some((m) => m.file === 'pages/v2/estimates/components/newEstimateDialog.tsx')).toBe(true);
    expect(matches.some((m) => m.file === 'components/estimates/NewEstimateDialog.tsx')).toBe(true);
  });
});
