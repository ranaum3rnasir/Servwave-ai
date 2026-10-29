/**
 * MV-TZ-07 half (b). Timeline descriptions embed a raw UTC instant - staging holds rows
 * reading "Visit 2 scheduled for 2026-08-25T17:00:00.000Z" - and the Activity panel
 * rendered that description verbatim, so a bare Z string reached EVERY viewer in EVERY
 * zone on the job page. The plan explicitly asks to flag any row rendering a raw ISO
 * string ending in Z.
 *
 * The writers no longer emit these, but the rows already stored do, and nothing rewrites
 * history - so the renderer has to cope. As elsewhere in this suite the assertion is that
 * the result is fixed by the ORG zone argument, not by the zone the runner happens to be in.
 */
import { describe, it, expect } from 'vitest';

import { humanizeInstants } from '@/components/crm/ActivityPanel';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

describe('humanizeInstants', () => {
  it('renders an embedded UTC instant on the org clock', () => {
    expect(humanizeInstants('Visit 2 scheduled for 2026-08-25T17:00:00.000Z', NY))
      .toBe('Visit 2 scheduled for Aug 25, 2026 1:00 PM');
  });

  it('names the org day, not the viewer day, whatever zone is passed', () => {
    // The same instant is Aug 26 in Manila. An org on the Manila clock should say so;
    // a New York org must not, and neither answer may depend on the runner's zone.
    expect(humanizeInstants('Visit 2 scheduled for 2026-08-25T17:00:00.000Z', MANILA))
      .toBe('Visit 2 scheduled for Aug 26, 2026 1:00 AM');
  });

  it('leaves no bare Z string behind', () => {
    const out = humanizeInstants('Visit 4 rescheduled for 2026-09-29T13:00:00.000Z', NY);
    expect(out).not.toMatch(/\dZ/);
    expect(out).not.toContain('T13:00');
  });

  it('rewrites every instant in a description, not just the first', () => {
    const out = humanizeInstants('Moved 2026-08-25T17:00:00.000Z to 2026-08-26T17:00:00.000Z', NY);
    expect(out).toBe('Moved Aug 25, 2026 1:00 PM to Aug 26, 2026 1:00 PM');
  });

  it('accepts an instant written without milliseconds', () => {
    expect(humanizeInstants('at 2026-08-25T17:00:00Z', NY)).toBe('at Aug 25, 2026 1:00 PM');
  });

  it('leaves prose that merely contains digits alone', () => {
    // A job number, a quantity and a plain date must not be touched - the pattern is
    // anchored on the T separator and the trailing Z, not on loose digits.
    const prose = 'Job J00234 - 3 units - due 2026-08-25';
    expect(humanizeInstants(prose, NY)).toBe(prose);
  });

  it('returns notes and other plain text unchanged', () => {
    expect(humanizeInstants('Customer called back, no times discussed', NY))
      .toBe('Customer called back, no times discussed');
  });
});
