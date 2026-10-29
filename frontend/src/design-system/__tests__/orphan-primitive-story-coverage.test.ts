/* =============================================================================
   Orphan primitive story coverage guard - phase 12a pass.

   THE GAP THIS CLOSES. `SectionCard`/`SectionLabel` (components/jobs/overview)
   and the raw `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/
   `TableCell`/`TableFooter`/`TableCaption` cluster (components/data/table.tsx)
   are both real, widely-shared primitives - SectionCard alone has 17 real
   call sites outside the jobs feature - but `DesignSystemPage` was their
   only rendered example anywhere, and it was never wired into Storybook.
   Retiring that page (phase 12a) without giving both a real story first
   would have deleted their only designer-facing documentation with nothing
   to replace it.

   WHY THIS IS A SEPARATE, NARROWER FILE rather than folding into
   `pattern-story-coverage.test.ts` or `chart-story-coverage.test.ts`. Both
   of those guards enforce a STANDING, directory-wide policy ("every file in
   this shared root needs a story") appropriate for a layer that is entirely
   shared components. SectionCard and the Table cluster are each ONE
   component living in a directory that is NOT entirely shared components
   (components/jobs/overview holds job-feature-specific cards too;
   components/data holds many components this pass did not touch) - a
   directory-wide rule here would immediately fail on real, legitimate gaps
   this PR does not claim to fix. So this file asserts coverage for exactly
   these two named components, not a policy for their directories.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const STORYBOOK_MAIN = resolve(HERE, '..', '..', '..', '.storybook', 'main.ts');

describe('orphan primitive story coverage (SectionCard and the Table cluster)', () => {
  it('SectionCard.stories.tsx exists, and .storybook/main.ts globs its directory', () => {
    expect(existsSync(resolve(SRC, 'components/jobs/overview/SectionCard.stories.tsx'))).toBe(true);
    const main = readFileSync(STORYBOOK_MAIN, 'utf8');
    expect(main).toMatch(/components\/jobs\/overview\/\*\*\/\*\.stories\./);
  });

  it('table.stories.tsx exists, and .storybook/main.ts globs its directory', () => {
    expect(existsSync(resolve(SRC, 'components/data/table.stories.tsx'))).toBe(true);
    const main = readFileSync(STORYBOOK_MAIN, 'utf8');
    expect(main).toMatch(/components\/data\/\*\*\/\*\.stories\./);
  });
});
