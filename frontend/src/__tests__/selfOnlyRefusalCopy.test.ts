/**
 * THE SELF-ONLY RULE IS THE API'S TO STATE, AND NO FORM RESTATES IT UP FRONT.
 *
 * This file used to PIN four copies of one sentence together. Three of them were frontend copies
 * printed under a locked crew/performer field before anything was posted:
 *
 *   - `pages/v2/leads/components/walkthroughTab.tsx`          (inline JSX text)
 *   - `pages/v2/schedule/components/unifiedDropModal.tsx`     via `selfOnlyNote`
 *   - `pages/v2/schedule/components/eventEditor.tsx`          via `selfOnlyNote`
 *
 * The product owner asked for that subtitle to be removed from the Walkthrough tab: a field that
 * is locked and offers no dropdown already communicates the rule, so the sentence was redundant.
 * It came off all three surfaces in one change rather than one, because the board's walkthrough
 * card printed the IDENTICAL sentence and the board's job cards printed its twin - leaving either
 * would have made the app say on one screen what it had just stopped saying on another. The
 * helper that produced them (`scheduleModel.selfOnlyNote`) went with them.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT:
 *
 *   BACKEND (the source of truth - these are the strings a 403 actually carries)
 *     - `job.controller.ts`          ASSIGN_CREW_SELF_ONLY
 *     - `walkthrough.service.ts`     PERFORMER_SELF_ONLY
 *
 * The API still refuses in exactly those words, and every surface still renders a refusal it
 * receives (`extractApiError`). What is gone is the promise made BEFORE the post.
 *
 * So this file inverted rather than being deleted: it still reads both trees - the only thing in
 * either suite that does - but it now asserts the frontend does NOT restate what the backend
 * refuses with. A future re-add of the subtitle turns this red instead of landing silently.
 *
 * COMMENTS ARE STRIPPED BEFORE THE SEARCH, deliberately. All three surfaces now carry a note
 * explaining why there is no subtitle, and those notes quote the sentence they are about. A guard
 * that could not tell a comment from a rendered string would force the explanation to be written
 * in circumlocutions, which is how the next person re-adds the line by accident.
 *
 * The backend extractions FAIL LOUDLY when they match nothing: renaming or restructuring a
 * constant must turn this red rather than quietly comparing against nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repo root - this file sits at frontend/src/__tests__/. */
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** The single-quoted literal a named `const` is initialised with, in a source file. */
function constLiteral(source: string, name: string, where: string): string {
  const match = new RegExp(`const ${name} = '([^']+)';`).exec(source);
  if (!match) {
    throw new Error(
      `Could not find \`const ${name}\` in ${where}. If it was renamed or moved, update this ` +
      'test - do not delete it: it is the only check that reads both trees.',
    );
  }
  return match[1]!;
}

/**
 * Source with every `//` line comment and `/* *\/` block comment blanked out - which covers JSX
 * `{/* ... *\/}` notes too, since those are block comments wrapped in braces. Strings are left
 * alone, so a re-added literal is still found.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const JOB_CONTROLLER = read('backend/src/controllers/job.controller.ts');
const WALKTHROUGH_SERVICE = read('backend/src/services/walkthrough.service.ts');

const ASSIGN_CREW_SELF_ONLY = constLiteral(JOB_CONTROLLER, 'ASSIGN_CREW_SELF_ONLY', 'job.controller.ts');
const PERFORMER_SELF_ONLY = constLiteral(WALKTHROUGH_SERVICE, 'PERFORMER_SELF_ONLY', 'walkthrough.service.ts');

/** Every frontend file that used to print one of the two sentences, plus the helper that built them. */
const SURFACES: ReadonlyArray<readonly [string, string]> = [
  ['the lead Walkthrough tab', 'frontend/src/pages/v2/leads/components/walkthroughTab.tsx'],
  ['the board drop modal', 'frontend/src/pages/v2/schedule/components/unifiedDropModal.tsx'],
  ['the board event editor', 'frontend/src/pages/v2/schedule/components/eventEditor.tsx'],
  ['the shared schedule model', 'frontend/src/components/schedule/scheduleModel.ts'],
];

describe('no locked crew/performer field states the self-only rule before the post', () => {
  it.each(SURFACES)('%s does not restate either API refusal', (_label, rel) => {
    const code = withoutComments(read(rel));
    expect(code).not.toContain(PERFORMER_SELF_ONLY);
    expect(code).not.toContain(ASSIGN_CREW_SELF_ONLY);
  });

  it('the helper that produced the two sentences is gone, not merely unused', () => {
    // `selfOnlyNote` was the one copy both board surfaces shared. Leaving it exported with no
    // renderer is how the line comes back: the next person wiring up a third board surface finds
    // a ready-made helper and assumes it is the house style.
    expect(read('frontend/src/components/schedule/scheduleModel.ts')).not.toContain('selfOnlyNote');
  });

  it('the API still refuses in those words - this change is frontend-only', () => {
    // The whole point of removing the subtitle is that the rule is the SERVER's to state, when it
    // is actually broken. If either constant is ever emptied or softened, the rule stops being
    // stated anywhere at all and the assertions above become a guard over nothing.
    expect(PERFORMER_SELF_ONLY).toMatch(/\S/);
    expect(ASSIGN_CREW_SELF_ONLY).toMatch(/\S/);
    expect(JOB_CONTROLLER).toContain(ASSIGN_CREW_SELF_ONLY);
    expect(WALKTHROUGH_SERVICE).toContain(PERFORMER_SELF_ONLY);
  });

  it('keeps the twins apart - the two validators do not share wording on purpose', () => {
    // "Do not merge the twins": one has to name crew, the other a walkthrough.
    expect(PERFORMER_SELF_ONLY).not.toBe(ASSIGN_CREW_SELF_ONLY);
  });
});
