/* =============================================================================
   Type scale guard (mobile slice 18, rubric A11Y-02) - the measured screens.

   A `text-[13px]` stays 13 px when the user enlarges their text to 200%
   (`html { font-size: 200% }`), while the spacing around it (rem) doubles, so the
   control grows and its label does not. The text of the screens the audit measured
   (the lead form, the DataTable and jobs toolbars, the schedule toolbar, the dashboard
   KPI tiles and the controls under all of them) is set in rem, which equals the old
   px at the default root size (13 px -> 0.8125rem).

   Zero tolerance on the files below. Everything else in the app (about 1,900 more
   bracket sizes) is the separate app-wide migration and is not asserted here:
   adding a file to WATCHED is how a later pass takes ownership of it.

   Not watched: px in a comment (comment lines are skipped), and px that is not a
   font size (`w-[640px]`, `h-[26px]`).
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = resolve(SRC, '..');

/** A px font size as Tailwind writes it: `text-[13px]`, `text-[12.5px]`, `touch:text-[14px]`. */
const PX_TEXT = /text-\[\d+(?:\.\d+)?px\]/g;

/** Whole files: every font size in them is rem. */
const WATCHED: Record<string, string> = {
  // The title block every page opens with.
  'ui-kit/components/layout/pageHeader.tsx': 'page title and description',
  // Controls under every toolbar and form on the measured screens.
  'ui-kit/components/ui/button.tsx': 'button sizes (Create Lead, Filter, Export, the toolbars)',
  'ui-kit/components/ui/label.tsx': 'field labels (the lead form)',
  'ui-kit/components/form/formField.tsx': 'field hint and error text (the lead form)',
  // DataTable (leads, customers, jobs lists).
  'ui-kit/components/data/dataTable/dataTable.tsx': 'phone cards',
  'ui-kit/components/data/dataTable/dataTableColumnHeader.tsx': 'column headers',
  'ui-kit/components/data/dataTable/dataTablePagination.tsx': 'pagination',
  'components/filters/FilterBar.tsx': 'the Filter trigger and its counts',
  // Dashboard.
  'components/dashboard/widgets/KpiCard.tsx': 'KPI tile label, value and detail',
  'pages/v2/dashboard/DashboardPage.tsx': 'dashboard edit bar',
  // Schedule toolbar.
  'pages/v2/schedule/components/toolbarSizing.ts': 'the toolbar text size',
  'pages/v2/schedule/components/compactToolbar.tsx': 'the phone toolbar',
  'pages/v2/_shared/segmented.tsx': 'toolbar segmented control',
  'pages/v2/schedule/components/scheduleSearch.tsx': 'toolbar search',
  'pages/v2/schedule/components/settingsGearDropdown.tsx': 'toolbar settings menu',
  'pages/v2/schedule/components/menuSurface.tsx': 'toolbar menu items',
};

const read = (file: string) => readFileSync(resolve(SRC, file), 'utf8');

/** Offending tokens, skipping comment lines (this repo's guards redden on their own prose). */
function pxFontSizes(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) continue;
    out.push(...(line.match(PX_TEXT) ?? []));
  }
  return out;
}

describe('type scale guard (mobile slice 18, A11Y-02)', () => {
  it('finds a px font size (the guard can fail)', () => {
    expect(pxFontSizes('<p className="text-[13px] touch:text-[14.5px] w-[640px]">')).toEqual(['text-[13px]', 'text-[14.5px]']);
    expect(pxFontSizes('<p className="text-[0.8125rem] text-xs h-[26px]">')).toEqual([]);
    expect(pxFontSizes('// was text-[13px]\n * text-[12px]\n<p className="text-sm">')).toEqual([]);
  });

  for (const [file, what] of Object.entries(WATCHED)) {
    it(`${file} sets its text in rem (${what})`, () => {
      expect(pxFontSizes(read(file))).toEqual([]);
    });
  }

  it("the schedule page's toolbar region sets its text in rem", () => {
    const src = read('pages/v2/schedule/SchedulePage.tsx');
    const start = src.indexOf('{compactToolbar ? (');
    const end = src.indexOf('data-compact-toolbar=');
    expect(start, 'toolbar start marker moved').toBeGreaterThan(0);
    expect(end, 'toolbar end marker moved').toBeGreaterThan(start);
    expect(pxFontSizes(src.slice(start, end))).toEqual([]);
  });

  it("the Tailwind config's own font-size keys are rem", () => {
    const cfg = readFileSync(resolve(FRONTEND, 'tailwind.config.js'), 'utf8');
    const block = cfg
      .slice(cfg.indexOf('fontSize: {'), cfg.indexOf('boxShadow: {'))
      .replace(/\/\/.*$/gm, ''); // a comment may say what the px was
    expect(block).toContain("'3xs'");
    expect(block).not.toMatch(/\d+px/);
  });
});
