/**
 * #2090 - `estimate-document-view.ts` exists TWICE, and nothing compared the two copies.
 *
 * `backend/src/lib/estimate-document-view.ts` feeds both PDF templates.
 * `frontend/src/lib/estimate-document-view.ts` feeds the web page and the public estimate page.
 * They are hand-kept mirrors, and every symbol they share is part of one contract: what a document
 * SAYS. The PDF suites import the backend copy and the web suites import the frontend copy, so
 * before this test each side passed happily against its own definition and a drifted pair was
 * invisible - the same estimate would have printed two materially different documents to the same
 * customer with every gate green.
 *
 * The constants are the obvious hazard, but the predicates are the dangerous one: if
 * `isOptionalExtra` or `optionalMarkerFor` drifts, the page and the attachment disagree about
 * WHICH ROWS are marked optional at all, not merely about the wording.
 *
 * WHY A SOURCE SCAN AND NOT A SHARED MODULE: there is no shared workspace to put one in. The root
 * package.json declares exactly ["backend", "frontend"] and neither tree imports across that
 * boundary anywhere. The duplication is structural, not laziness, and a frontend test cannot
 * import a backend module to compare the two at runtime. This equality guard is the correct
 * ceiling; please do not "fix" it into an import that cannot resolve.
 *
 * Only symbols exported by BOTH files are compared. Each file legitimately holds plenty the other
 * has no use for, and that divergence is none of this test's business.
 *
 * WHAT IS COMPARED: the declaration with its comments stripped and its whitespace collapsed. The
 * contract is what the two files DO, and prose is allowed to differ in voice between a file that
 * talks about PDF templates and one that talks about the DOM (their headers already do). Stripping
 * comments still compares every constant's VALUE, every predicate's body and every field and type
 * on a shared interface, which is the whole of what a customer can be shown differently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const FRONTEND = join(__dirname, '../lib/estimate-document-view.ts');
// Up out of frontend/src/__tests__ to the repo root, then down into the other workspace. Resolved
// from __dirname rather than from cwd so it holds however vitest is invoked.
const BACKEND = join(__dirname, '../../..', 'backend/src/lib/estimate-document-view.ts');

/**
 * Every top-level exported name in a file, mapped to the source text of its declaration.
 *
 * The declaration runs from `export ...` to the first line that is column-zero `}` (a function,
 * interface or type body) or, for a one-line `export const X = ...;`, that line alone. Both twins
 * are written in the same house style, which is what makes this tractable; a declaration this
 * cannot parse simply does not appear, and so is not guarded rather than being falsely compared.
 */
function exportedDeclarations(path: string): Map<string, string> {
  const lines = readFileSync(path, 'utf8').split('\n');
  const out = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const match = /^export (?:const|function|interface|type) ([A-Za-z0-9_]+)/.exec(lines[i]);
    if (!match) continue;

    let end = i;
    if (/;\s*$/.test(lines[i]) && !lines[i].trimEnd().endsWith('{')) {
      end = i; // a complete one-line declaration
    } else {
      while (end < lines.length - 1 && lines[end] !== '}') end++;
    }
    out.set(match[1], lines.slice(i, end + 1).join('\n'));
    i = end;
  }
  return out;
}

/** The declaration's code, with comments removed and runs of whitespace collapsed to one space. */
function withoutComments(declaration: string): string {
  return declaration
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const frontend = exportedDeclarations(FRONTEND);
const backend = exportedDeclarations(BACKEND);
const shared = [...frontend.keys()].filter((name) => backend.has(name)).sort();

describe('#2090 the estimate-document-view twins do not drift', () => {
  // A guard that finds nothing to guard is not a guard. If a refactor renames every shared symbol
  // at once, this is what says so rather than the file quietly passing with an empty list.
  it('finds the shared contract at all', () => {
    expect(shared.length).toBeGreaterThanOrEqual(10);
    // The three that decide which rows a customer sees marked, by name, so a rename has to be
    // deliberate rather than silent.
    expect(shared).toEqual(expect.arrayContaining([
      'isOptionalExtra',
      'hasOptionalExtras',
      'optionalMarkerFor',
      'OPTIONAL_ROW_MARKER',
      'OPTIONAL_INCLUDED_MARKER',
      'OPTIONAL_TOTALS_NOTE',
    ]));
  });

  it.each(shared)('%s is identical in both twins', (name) => {
    expect(withoutComments(frontend.get(name)!)).toBe(withoutComments(backend.get(name)!));
  });
});
