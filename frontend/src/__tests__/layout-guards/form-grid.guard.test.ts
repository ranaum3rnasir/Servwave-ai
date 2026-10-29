/* =============================================================================
   Form-grid guard (mobile slice 20, rubric CMP-18) - a ratchet.

   A form row written as `grid grid-cols-4` splits the screen four ways at EVERY
   width. On a 320 px phone that left a 49 px price box in Add Item, a 37 px
   State box on the customer form and a date box too narrow to read its own
   date in the visit dialog. Form grids are one column below `sm`:

     grid grid-cols-1 gap-3 sm:grid-cols-4

   (and a `col-span-N` inside one becomes `sm:col-span-N`, or the one-column
   grid grows implicit columns to honour the span).

   Watched: `grid-cols-2` ... `grid-cols-12` with no min-width breakpoint
   (`sm:`/`md:`/`lg:`/`xl:`/`2xl:`/`min-[...]:`/`@container`) in a .tsx file
   that renders a text entry or choice control (Input, Textarea, Select,
   SelectField, DateField, TimeField, AddressAutocomplete, PhoneInput). Two-up KPI tiles in
   a file with no form control are not form grids and are not watched.
   NOT watched: arbitrary `grid-cols-[...]` tracks (label/value pairs and
   line-item rows); the bare-fr guard covers their shrinkability.

   RATCHET, NOT ZERO TOLERANCE. Today's offenders are listed in
   `form-grid-allowlist.json` (file -> class -> count). The list may only
   shrink:
   - a new unprefixed form grid anywhere, or one more in a listed file, fails;
   - a listed entry that is no longer in the source fails until it is removed;
   - the list's total must equal ALLOW_LIST_CEILING, so growing the JSON fails
     unless the ceiling is raised in the same diff, where review sees it.
   When you fix an offender: delete its entry and lower the ceiling.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import allowList from './form-grid-allowlist.json';
import {
  allowListSize,
  diffAgainstAllowList,
  findUnprefixedFormGrids,
  sourceFiles,
  tallyFiles,
  type Tally,
} from './scan';

/** The number of allow-listed unprefixed form grids. It only ever goes DOWN. */
const ALLOW_LIST_CEILING = 89;

const FORM = (body: string) => `<form><Input id="a" />${body}</form>`;
const tokens = (src: string, file = 'x.tsx') => findUnprefixedFormGrids(src, file).map((o) => o.token);

describe('form-grid guard (mobile slice 20, CMP-18)', () => {
  const files = sourceFiles();
  const actual = tallyFiles(files, findUnprefixedFormGrids);
  const allowed = allowList as Tally;

  it('the pattern fires on unprefixed multi-column grids in a file with form controls', () => {
    expect(tokens(FORM('<div className="grid grid-cols-4 gap-3">'))).toEqual(['grid-cols-4']);
    expect(tokens(FORM('<div className="grid grid-cols-6 gap-3">'))).toEqual(['grid-cols-6']);
    expect(tokens(FORM("<div className={cn('grid gap-3', 'grid-cols-2')}>"))).toEqual(['grid-cols-2']);
    expect(tokens(FORM('<div className="grid grid-cols-12">'))).toEqual(['grid-cols-12']);
    // A small-screens-only or state variant still applies on a phone.
    expect(tokens(FORM('<div className="max-sm:grid-cols-2">'))).toEqual(['grid-cols-2']);
    expect(tokens(FORM('<div className="group-hover:grid-cols-3">'))).toEqual(['grid-cols-3']);
    // Every control kind marks a form file.
    for (const control of ['<Textarea', '<textarea', '<select', '<Select value', '<SelectField', '<DateField', '<TimeField', '<AddressAutocomplete', '<AutoGrowTextarea', '<input', '<PhoneInput']) {
      expect(tokens(`${control} /><div className="grid grid-cols-2">`), control).toEqual(['grid-cols-2']);
    }
  });

  it('the pattern stays quiet on gated, single-column, arbitrary and non-form grids', () => {
    expect(tokens(FORM('<div className="grid grid-cols-1 gap-3 sm:grid-cols-4">'))).toEqual([]);
    expect(tokens(FORM('<div className="grid md:grid-cols-2 lg:grid-cols-3">'))).toEqual([]);
    expect(tokens(FORM('<div className="grid min-[480px]:grid-cols-2 @md:grid-cols-3">'))).toEqual([]);
    expect(tokens(FORM('<div className="grid grid-cols-1">'))).toEqual([]);
    expect(tokens(FORM('<div className="grid grid-cols-[minmax(0,1fr)_80px]">'))).toEqual([]);
    expect(tokens(FORM('<div className="col-span-2 grid-cols-subgrid">'))).toEqual([]);
    // KPI tiles in a file with no form control are not a form grid.
    expect(tokens('<div className="grid grid-cols-2 gap-2"><StatCard /></div>')).toEqual([]);
    // <SelectTrigger> / <SelectItem> alone do not make a form file.
    expect(tokens('<SelectTrigger /><SelectItem /><div className="grid grid-cols-2">')).toEqual([]);
    // Not a .tsx file.
    expect(tokens(FORM('<div className="grid grid-cols-2">'), 'x.ts')).toEqual([]);
    // Prose about the bug is not the bug.
    expect(tokens(FORM('\n  // was grid-cols-4, which left a 49 px price box'))).toEqual([]);
    expect(tokens(FORM('\n   * the old `grid grid-cols-6` City/State/ZIP row'))).toEqual([]);
  });

  it('scanned the source tree', () => {
    // A guard over an empty file list is green for the wrong reason.
    expect(files.length).toBeGreaterThan(500);
  });

  it('no unprefixed form grid outside the allow-list - use grid-cols-1 sm:grid-cols-N', () => {
    const { grown } = diffAgainstAllowList(actual, allowed);
    expect(
      grown,
      `Form grids are one column below sm: write grid-cols-1 sm:grid-cols-N (and sm:col-span-N inside):\n${grown.join('\n')}`,
    ).toEqual([]);
  });

  it('no stale allow-list entry - the list only shrinks', () => {
    const { stale } = diffAgainstAllowList(actual, allowed);
    expect(
      stale,
      `These offenders are fixed. Remove them from form-grid-allowlist.json and lower ALLOW_LIST_CEILING:\n${stale.join('\n')}`,
    ).toEqual([]);
  });

  it('the allow-list does not grow', () => {
    expect(
      allowListSize(allowed),
      'form-grid-allowlist.json must hold exactly ALLOW_LIST_CEILING entries. Never raise the ceiling to admit new code; lower it when you fix one.',
    ).toBe(ALLOW_LIST_CEILING);
  });

  it('a deliberately added offender is reported', () => {
    const planted = [...files, ['pages/Planted.tsx', FORM('<div className="grid grid-cols-3 gap-3">')] as const];
    const { grown } = diffAgainstAllowList(tallyFiles(planted, findUnprefixedFormGrids), allowed);
    expect(grown).toEqual(['pages/Planted.tsx: grid-cols-3 x1 (allowed 0)']);
  });

  it('the slice-20 forms are not on the allow-list', () => {
    // The job form, the visit dialog's date and time, Add Item and the customer form were fixed
    // by slice 20; re-listing them would hide a regression on exactly the screens it measured.
    for (const file of [
      'pages/v2/jobs/JobFormPage.tsx',
      'pages/v2/_shared/scheduleTimeFields.tsx',
      'components/jobs/items/AddLineDialog.tsx',
      'pages/v2/customers/CustomerFormPage.tsx',
      'pages/v2/leads/LeadFormPage.tsx',
    ]) {
      expect(allowed[file], file).toBeUndefined();
    }
  });
});
