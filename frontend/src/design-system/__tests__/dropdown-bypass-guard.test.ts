/* =============================================================================
   ServWave Design System - dropdown bypass guard (§4.2 ratchet)

   THE RULE (DESIGN_SYSTEM.md §4.2): a dropdown with 10 or more options is a
   searchable combobox; fewer than 10 is a plain select. Nothing else is
   considered - not whether the list is hardcoded, not whether a user can add to
   it, not which module it lives in.

   THE MECHANISM: the count is read INSIDE the primitive (`options.length` at
   render time), never at the call site. That single read is what makes the rule
   retroactive (every existing dropdown obeys it the moment the primitive does),
   automatic over the customer's data (six vendors vs sixty, same code, same
   day), and automatic over time (a fixed list of three that grows to ten becomes
   a combobox on the commit that adds the tenth option).

   There are exactly two entry points, one per Select family, and both read the
   single `SEARCH_THRESHOLD` from `@/ui-kit/lib/selectThreshold`:

     - `@/components/form/SelectField`          (app family - components/ui/select)
     - `@/ui-kit/components/form/selectField`   (kit family - ui-kit/components/ui/select)

   WHY THIS GUARD EXISTS
     §4.2 names two ways to bypass the rule, and neither one fails anywhere:

       1. `<select>` - a native element leaves the design system altogether. The
          primitive never runs, so the rule cannot apply.
       2. `<Select><SelectContent>{xs.map(...)}</SelectContent></Select>` - a
          hand-composed dropdown puts the option count where the primitive
          cannot read it. The rule silently does not apply, and nothing says so.

     Steps 1-4 built the primitives and converted every live bypass. Without a
     ratchet the tree drifts straight back, because a bypass looks exactly like
     ordinary working code. This is the ratchet.

   WHAT IT CHECKS
     1. NATIVE SELECT - pinned at ZERO. There is no allowlist and there should
        never be one: a native `<select>` is not a §4.2 exception, it is a
        different design system.
     2. MAPPED SelectContent - an explicit file allowlist (below), every entry
        carrying its reason. A NEW file, or a new mapped block in an unlisted
        file, fails.
     3. OVERLONG LITERAL SelectContent - a hand-composed block holding
        SEARCH_THRESHOLD or more literal `<SelectItem>` children. Pinned at
        ZERO, no allowlist: today's 12 literal blocks hold 2-4 items each.
        This is NOT redundant with check 2 - check 2 keys on `.map(`, so a
        hand-TYPED list of twelve items is invisible to it, while being exactly
        the thing §4.2 says must be searchable. §4.2 explicitly blesses short
        literal lists ("Hand-composed *literal* lists are fine and are not the
        target"), so the threshold, not the composition, is what this reads.
     4. HAND-ROLLED ENTITY-FILTER PANEL - the SECOND family, and a different
        bypass from checks 1-3. Those three all watch the Radix Select route.
        This one watches a Popover route that never touches Select at all: a
        pill trigger over a `<PopoverContent>` that MAPS ENTITY ROWS carrying
        per-row edit/delete affordances - the Inventory category / location
        pills, the Vendors category pill. Its home is now
        `@/components/ui/searchable-panel`, which owns the search box for the
        whole family (DESIGN_SYSTEM.md §4.2, "entity-filter pills are always
        searchable"). A panel of this shape that is NOT built on the primitive
        gets no search, and nothing says so - the exact hole this guard closes.

        Detected at FILE level, not block level, on purpose: two of the three
        converted panels rendered their rows from a sibling component in the
        same file (`LocationRow`), so a body-scoped scan for the edit/delete
        icons would have missed the very panels that prompted this check. All
        three ARE caught by the file-level form, verified against their
        pre-conversion source.

        KNOWN LIMIT, stated rather than papered over: a panel that hand-rolls
        its own `createPortal` surface instead of using Popover is invisible
        here, because it renders no `<PopoverContent>` at all. Widening the
        detector to "any portal with a mapped list" would sweep in every menu,
        tooltip and dialog in the tree, and a guard that cries wolf gets deleted
        by the next person - so the narrow, reliable signal is the one kept, and
        the gap is written down here instead.

        `inventory/StagingAreaPicker.tsx` WAS that shape, and was named here as
        the live instance of the gap. It is now on the primitive (its ~80 lines
        of getBoundingClientRect positioning, scroll/resize listeners and
        `createPortal` deleted in favour of Popover's own portal, `align="end"`
        and `avoidCollisions`), so the sentence naming it would now be false and
        is gone. The LIMIT itself is not fixed - it is a property of the
        detector, and the next hand-rolled portal panel is still invisible to
        it. The regression test below pins the picker by name so it cannot
        quietly go back.

   SCOPE
     All of frontend/src, excluding `__tests__` dirs and `*.test.tsx` /
     `*.spec.tsx` files - a test may legitimately render a raw `<select>` as a
     fixture, and several do. `*.stories.tsx` IS in scope: a story that
     hand-composes a long dropdown is documenting the bypass as acceptable,
     which is the thing being ratcheted. (Checked at seed time: the six blocks
     in `components/ui/select.stories.tsx` are literal and hold 2-4 items, so
     they pass on their merits, not by exemption.)

   COMMENT STRIPPING IS LOAD-BEARING
     Several files carry the string `<select>` inside a comment describing what
     they replaced ("A custom dropdown (not a native <select>) so the open panel
     ...", "the native `<select>` becomes a kit Select"). Seven such comments
     sit in non-test files at seed time. Without stripping, this guard would be
     red on day one against files that are already correct.

     Line comments are stripped BEFORE block comments, per the lesson recorded
     in the sibling shadow component guard in this directory: a line comment can
     contain a stray `/*`-looking substring, and running the block regex first
     swallows real code up to the next unrelated closer. (That guard's exact
     file name is deliberately not spelled out anywhere in this file -
     unresolved-classes-guard.test.ts extracts utility-shaped tokens from prose
     too, so writing it out registers a Tailwind candidate class that resolves
     to nothing and turns THAT guard red. Found the hard way, here.)

   THE NATIVE-SELECT REGEX
     `/<select(?=[\s/>])/` - the lookahead accepts `<select>`, `<select ` AND
     `<select\n`, because `\s` matches a newline. This matters: both of the
     native selects removed in steps 1-4 were written with their attributes on
     the next line, and a naive `<select[ >]` misses that form entirely. The
     same undercount (83 vs 849) is recorded in component-api-guard.test.ts.
     Asserted below rather than assumed.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SEARCH_THRESHOLD } from '@/ui-kit/lib/selectThreshold';

// This file lives at frontend/src/design-system/__tests__/, so frontend/src is
// two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');

/** Recursively list .ts/.tsx under a dir, skipping __tests__ dirs and
 *  test/spec files. Stories are deliberately IN scope - see header. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === '__tests__') return [];
    if (statSync(p).isDirectory()) return walk(p);
    if (/\.(test|spec)\.(ts|tsx)$/.test(p)) return [];
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/** Blank out comments, line comments FIRST, then block comments - see header.
 *
 *  Comment bodies are replaced with SPACES rather than deleted, and newlines
 *  inside a block comment are kept. Deleting them shifts every line number
 *  after the comment, and this tree is heavily commented: a planted <select>
 *  on line 292 of assetsView.tsx reported as line 259 while this function
 *  deleted instead of blanking. A failure message that names the wrong line
 *  sends the reader hunting, which is most of the value of the guard gone. */
function stripComments(src: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return src
    .replace(/(^|[^:])(\/\/.*)$/gm, (_m, pre: string, body: string) => pre + blank(body))
    .replace(/\/\*[\s\S]*?\*\//g, blank);
}

/** Native `<select>`: `<select>`, `<select ` and `<select\n` all count. */
const NATIVE_SELECT_RE = /<select(?=[\s/>])/g;

/** One `<SelectContent>...</SelectContent>` block. Non-greedy: SelectContent
 *  never nests, so the first closer is always the right one. */
const SELECT_CONTENT_BLOCK_RE = /<SelectContent[\s\S]*?<\/SelectContent>/g;

/** A literal `<SelectItem>` child - word-boundaried so it never counts a
 *  hypothetical `<SelectItemGroup>`. */
const SELECT_ITEM_RE = /<SelectItem(?=[\s/>])/g;

/** One `<PopoverContent>...</PopoverContent>` block - check 4. Non-greedy for
 *  the same reason SELECT_CONTENT_BLOCK_RE is: PopoverContent never nests. */
const POPOVER_CONTENT_BLOCK_RE = /<PopoverContent[\s\S]*?<\/PopoverContent>/g;

/** A per-row MUTATION affordance - what separates a management surface (the
 *  entity-filter family) from a plain menu, a preset list or an emoji grid.
 *  Read against the WHOLE FILE, not the popover body: `LocationSelector.tsx`
 *  put its Pencil/Trash2 inside a sibling `LocationRow` component, and a
 *  body-scoped scan would have missed it. */
const ROW_MUTATION_RE =
  /<(Pencil|Trash2|SquarePen)(?=[\s/>])|aria-label={`(Edit|Delete|Rename) |aria-label="(Edit|Delete|Rename) /;

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split('\n').length;
}

function relFile(file: string): string {
  return relative(SRC, file).split('\\').join('/'); // posix-normalize on Windows
}

interface NativeHit {
  file: string; // relative to frontend/src
  line: number;
}

interface BlockHit {
  file: string; // relative to frontend/src
  line: number;
  mapped: boolean; // body contains `.map(`
  literalItems: number; // count of literal <SelectItem> children
}

interface PanelHit {
  file: string; // relative to frontend/src
  line: number;
}

function scan(): { native: NativeHit[]; blocks: BlockHit[]; panels: PanelHit[] } {
  const native: NativeHit[] = [];
  const blocks: BlockHit[] = [];
  const panels: PanelHit[] = [];

  for (const file of walk(SRC)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const rel = relFile(file);

    NATIVE_SELECT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NATIVE_SELECT_RE.exec(code))) {
      native.push({ file: rel, line: lineOf(code, m.index) });
    }

    SELECT_CONTENT_BLOCK_RE.lastIndex = 0;
    while ((m = SELECT_CONTENT_BLOCK_RE.exec(code))) {
      const body = m[0];
      blocks.push({
        file: rel,
        line: lineOf(code, m.index),
        mapped: /\.map\(/.test(body),
        literalItems: (body.match(SELECT_ITEM_RE) ?? []).length,
      });
    }

    // check 4. `components/ui` is out of scope: the primitive itself, and
    // `combobox.tsx`, legitimately render a mapped PopoverContent - that is
    // what they ARE. Same scope exclusion the raw-tag ratchet uses.
    if (!rel.startsWith('components/ui/') && ROW_MUTATION_RE.test(code)) {
      POPOVER_CONTENT_BLOCK_RE.lastIndex = 0;
      while ((m = POPOVER_CONTENT_BLOCK_RE.exec(code))) {
        if (/\.map\(/.test(m[0])) {
          panels.push({ file: rel, line: lineOf(code, m.index) });
        }
      }
    }
  }

  return { native, blocks, panels };
}

// --- the allowlist (check 2 only) ---------------------------------------------
// Files permitted to hand-compose `<SelectContent>{...map(...)}</SelectContent>`.
// Seeded from the tree after step 4 converted every live bypass; every entry
// carries its reason, because an allowlist without reasons rots into a list
// nobody dares shrink. Four kinds of entry, and only three of them are
// permanent-ish: the entry points themselves, one documented §4.2 exception,
// one parked component, and ten dead v1 modules awaiting a dead-code pass.
//
// Reachability of the "dead v1" entries was verified by walking the import
// graph from App.tsx -> pages/v2/V2Routes.tsx -> pages/v2/routes/*.routes.tsx
// (auto-discovered via import.meta.glob): 892 files are reachable and none of
// the ten is among them. Several ARE imported - by other v1 modules that
// are themselves unreachable (StaffFormDialog <- StaffSection, StopIfForm <-
// StepConfigDrawer, DateModePanel <- TriggerForm), which is why a plain grep
// for importers is not the check.

interface AllowlistEntry {
  file: string; // relative to frontend/src
  reason: string;
}

const MAPPED_ALLOWLIST: AllowlistEntry[] = [
  // -- the two entry points: this is where the mapping is SUPPOSED to happen --
  {
    file: 'components/form/SelectField.tsx',
    reason:
      'THE APP-FAMILY ENTRY POINT. It is the thing that maps `options` into <SelectItem>s after reading options.length against SEARCH_THRESHOLD - the one place where hand-composition IS the design.',
  },
  {
    file: 'ui-kit/components/form/selectField.tsx',
    reason:
      'THE KIT-FAMILY ENTRY POINT, same role as the above for @/ui-kit/components/ui/select. Both read the single SEARCH_THRESHOLD from @/ui-kit/lib/selectThreshold.',
  },

  // -- a deliberate, documented §4.2 exception --------------------------------
  {
    file: 'pages/v2/_shared/timeSelect.tsx',
    reason:
      '97 options and DELIBERATELY a plain Select - documented in the file. The Select branch keeps Radix\'s own single-keystroke typeahead ("3" jumps to 3:00), where a substring filter over "h:mm a" labels would also match 1:30, 10:35 and 12:30. The searchable time control already exists beside it: timeCombobox.tsx parses "3p" / "15:00" / off-grid times via timeOptionMatchesQuery. A surface that wants search wants that file, not a text box bolted onto this one.',
  },

  // -- dead v1 code, unreachable from the route table --------------------------
  // These should be DELETED by a dead-code pass, not migrated. Do not convert
  // them: converting dead code costs review budget and makes the deletion diff
  // harder to read.
  {
    file: 'components/settings/StaffFormDialog.tsx',
    reason: 'dead v1 - unreachable from the route table (imported only by the equally unreachable StaffSection.tsx); awaiting the dead-code pass',
  },
  {
    file: 'components/workflows/StopIfForm.tsx',
    reason: 'dead v1 - unreachable from the route table (imported only by the equally unreachable StepConfigDrawer.tsx); awaiting the dead-code pass',
  },
  {
    file: 'components/workflows/trigger/DateModePanel.tsx',
    reason: 'dead v1 - unreachable from the route table (imported only by the equally unreachable TriggerForm.tsx); awaiting the dead-code pass',
  },
  {
    file: 'pages/CustomerFormPage.tsx',
    reason: 'dead v1 - /customers routes to pages/v2/customers/*; this page is unrouted. Awaiting the dead-code pass',
  },
  {
    file: 'pages/JobFormPage.tsx',
    reason: 'dead v1 - jobs.routes.tsx lazy-imports pages/v2/jobs/JobFormPage, not this one. Awaiting the dead-code pass',
  },
  {
    file: 'pages/LeadFormPage.tsx',
    reason: 'dead v1 - unreachable from the route table; awaiting the dead-code pass',
  },
  {
    file: 'pages/service-plans/ServicePlansPage.tsx',
    reason: 'dead v1 - unreachable from the route table; awaiting the dead-code pass',
  },
  {
    file: 'pages/settings/InventorySettingsPage.tsx',
    reason: 'dead v1 - settings.routes.tsx lazy-imports pages/v2/settings/InventorySettingsPage, not this one. Awaiting the dead-code pass',
  },
  {
    file: 'pages/settings/RolesPage.tsx',
    reason: 'dead v1 - /settings/roles routes to the v2 fork; this page is unrouted. Awaiting the dead-code pass',
  },
  {
    file: 'ui-kit/components/form/statusSelect.tsx',
    reason: 'dead v1 - unreachable from the route table; awaiting the dead-code pass',
  },
];

// --- the panel allowlist (check 4) --------------------------------------------
// Files permitted to hand-compose a mapped <PopoverContent> while ALSO carrying
// a row-mutation affordance somewhere in the file. Every one of these is a
// false positive of the file-level read - the Pencil/Trash2 lives elsewhere in
// the file and the popover itself is not an entity-filter panel. The list is
// kept (rather than the detector narrowed further) because narrowing it enough
// to drop these three also dropped LocationSelector, whose rows live in a
// sibling component. Three reasoned entries is the cheaper trade.

const PANEL_ALLOWLIST: AllowlistEntry[] = [
  {
    file: 'components/communication/inbox/ComposeWindow.tsx',
    reason:
      'The mapped PopoverContent is a 6-column EMOJI GRID (and, below it, a template list) on the compose toolbar - no rows, no reset, no per-row actions, nothing to search by label and subtitle. The Pencil the file-level read picks up belongs to the compose surface itself, not to this popover.',
  },
  {
    file: 'components/communication/phone/CallFlows.tsx',
    reason:
      'A hand-rolled single-line option list (label + check, w-[--radix-popover-trigger-width]) standing in for a Select on the call-flow editor - a §4.2 check-2 shape wearing a Popover, not an entity-filter panel. It has no reset row, no footer CTA and no per-row affordances; the file\'s Pencil belongs to the flow-step editor.',
  },
  {
    file: 'pages/v2/reports/reports/CommissionsReport.tsx',
    reason:
      'A DATE-RANGE PRESET MENU (RANGE_PRESETS + "Custom range..."), mapped over a fixed constant, not over entities. Nothing in it is creatable, renameable or deletable; the row-mutation match is elsewhere in the report.',
  },
  {
    file: 'pages/v2/schedule/SchedulePage.tsx',
    reason:
      'The VISIBLE-HOURS PRESET MENU on the toolbar zoom control - the same shape as CommissionsReport above, mapped over a fixed preset constant rather than over entities, with a From/To pair beside it. Nothing in it is creatable, renameable or deletable. The two Trash2 icons the file-level read picks up belong to the event editor and the unschedule confirm, both far from this popover.',
  },
];

// --- how to fix, quoted into every failure ------------------------------------

const ENTRY_POINTS =
  "Pass a flat `{ value, label }[]` to an entry point instead: `@/components/form/SelectField` (app family) or `@/ui-kit/components/form/selectField` (kit family). The primitive reads options.length against SEARCH_THRESHOLD (@/ui-kit/lib/selectThreshold) and picks plain-select vs searchable-combobox itself.";

const NATIVE_HELP = [
  'DESIGN_SYSTEM.md §4.2: a native <select> leaves the design system altogether,',
  'so the 10-option rule can never apply to it. This is pinned at zero and has no',
  'allowlist.',
  ENTRY_POINTS,
].join('\n');

const MAPPED_HELP = [
  'DESIGN_SYSTEM.md §4.2: hand-composing <SelectContent>{xs.map(...)}</SelectContent>',
  'puts the option count where the primitive cannot read it, so the 10-option rule',
  'silently does not apply - the dropdown will never become searchable, whatever',
  'the data does.',
  ENTRY_POINTS,
  'If you believe this file is a genuine exception, add it to MAPPED_ALLOWLIST in',
  'this file WITH ITS REASON - do not widen the regex.',
].join('\n');

const PANEL_HELP = [
  'DESIGN_SYSTEM.md §4.2 ("entity-filter pills are always searchable"): this file',
  'hand-composes a Popover panel that maps entity rows with per-row edit/delete',
  'affordances. That is the entity-filter pill family, and a hand-rolled one gets',
  'no search box - the exact defect that put 14 unsearchable categories on',
  'Inventory -> Items.',
  'Build it on `@/components/ui/searchable-panel` instead. `SearchablePanel` owns',
  'the popover, the always-on search box, the label+subtitle matching, the pinned',
  'reset row and the pinned footer CTA; you hand it `rows` (key / label / subtitle',
  '/ render) and your own row markup, so nothing about how the rows LOOK changes.',
  'The call site declares nothing about search, which is what makes the next panel',
  'inherit it without anyone remembering.',
  'If you believe this file is a genuine exception, add it to PANEL_ALLOWLIST in',
  'this file WITH ITS REASON - do not widen the regex.',
].join('\n');

const LITERAL_HELP = [
  `DESIGN_SYSTEM.md §4.2: a hand-composed <SelectContent> with ${SEARCH_THRESHOLD} or more literal`,
  '<SelectItem> children is a long dropdown that should be searchable and is not.',
  'Short literal lists are fine and are not the target; this is about the count.',
  ENTRY_POINTS,
].join('\n');

// --- the guard ----------------------------------------------------------------

describe('dropdown bypass guard (DESIGN_SYSTEM.md §4.2 - the 10-option rule)', () => {
  const { native, blocks, panels } = scan();

  it('scans a non-trivial, expected set of dropdown call sites', () => {
    // A silent zero here would mean the walker broke and every check below
    // passes vacuously.
    expect(blocks.length).toBeGreaterThan(30);
    expect(blocks.some((b) => b.file === 'components/form/SelectField.tsx')).toBe(true);
    expect(blocks.some((b) => b.file === 'pages/v2/_shared/timeSelect.tsx')).toBe(true);
  });

  it('check 1: no native <select> element anywhere outside tests', () => {
    const violations = native.map(
      (h) => `${h.file}:${h.line}: native <select> element. ${ENTRY_POINTS}`,
    );
    expect(violations, NATIVE_HELP).toEqual([]);
  });

  it('check 2: no non-allowlisted file hand-composes a mapped <SelectContent>', () => {
    const allowed = new Set(MAPPED_ALLOWLIST.map((a) => a.file));
    const violations = blocks
      .filter((b) => b.mapped && !allowed.has(b.file))
      .map(
        (b) =>
          `${b.file}:${b.line}: <SelectContent> body maps over an array, so the option count is invisible to the primitive. ${ENTRY_POINTS}`,
      );
    expect(violations, MAPPED_HELP).toEqual([]);
  });

  it(`check 3: no <SelectContent> holds ${SEARCH_THRESHOLD}+ literal <SelectItem> children`, () => {
    // Pinned at zero with NO allowlist - at seed time the 12 files with literal
    // blocks hold 2-4 items each. Independent of check 2's allowlist on
    // purpose: an entry-point exemption for mapping is not an exemption from
    // the count.
    const violations = blocks
      .filter((b) => b.literalItems >= SEARCH_THRESHOLD)
      .map(
        (b) =>
          `${b.file}:${b.line}: hand-composed <SelectContent> with ${b.literalItems} literal <SelectItem> children (threshold ${SEARCH_THRESHOLD}). ${ENTRY_POINTS}`,
      );
    expect(violations, LITERAL_HELP).toEqual([]);
  });

  it('check 4: no non-allowlisted file hand-rolls an entity-filter panel', () => {
    const allowed = new Set(PANEL_ALLOWLIST.map((a) => a.file));
    const violations = panels
      .filter((p) => !allowed.has(p.file))
      .map(
        (p) =>
          `${p.file}:${p.line}: hand-composed <PopoverContent> mapping entity rows in a file that also carries row edit/delete affordances - the entity-filter pill family, which gets no search unless it is built on SearchablePanel.`,
      );
    expect(violations, PANEL_HELP).toEqual([]);
  });

  it('check 4 scans a real population rather than passing vacuously', () => {
    // The detector walks a live tree. If the PopoverContent regex or the
    // mutation regex ever stops matching anything, check 4 would go green by
    // scanning nothing - the same vacuous-pass failure the block scan above
    // guards against. Every hit today is an allowlisted false positive, so the
    // floor is the allowlist itself.
    expect(panels.length).toBeGreaterThanOrEqual(PANEL_ALLOWLIST.length);
  });

  it('check 4: the converted panels are built on SearchablePanel, not hand-rolled', () => {
    // The load-bearing regression test. The first three WERE hits before the
    // conversion (verified against their pre-conversion source), so if one is
    // ever reverted to a hand-composed PopoverContent this goes red by name
    // rather than as an anonymous count.
    const converted = [
      'components/inventory/CategorySelector.tsx',
      'components/inventory/LocationSelector.tsx',
      'components/inventory/CategoryManagerDropdown.tsx',
      // The fourth, converted later: it never WAS a check-4 hit, because it
      // hand-rolled a createPortal surface and rendered no <PopoverContent>
      // (the KNOWN LIMIT in this file's header named it). So for this one the
      // first assertion below is vacuous and the SECOND is the whole point -
      // it is what fails if the picker is ever reverted to its own portal.
      'components/inventory/StagingAreaPicker.tsx',
    ];
    const regressed = converted.filter((f) => panels.some((p) => p.file === f));
    expect(regressed).toEqual([]);
    // ...and they really are on the primitive, not merely popover-free.
    for (const file of converted) {
      const src = readFileSync(join(SRC, file), 'utf8');
      // Quote-agnostic: this file family is authored with double quotes.
      expect(src, `${file} must import the shared panel primitive`).toMatch(
        /from ["']@\/components\/ui\/searchable-panel["']/,
      );
    }
  });

  it('every panel-allowlist entry is still a hit, and carries a reason', () => {
    // Same staleness idiom check 2's allowlist gets: an entry whose file no
    // longer trips the detector must be deleted with it, so the list SHRINKS.
    const hit = new Set(panels.map((p) => p.file));
    const stale = PANEL_ALLOWLIST.filter((a) => !hit.has(a.file)).map(
      (a) => `${a.file}: allowlisted for check 4, but no longer detected - delete this entry.`,
    );
    expect(stale).toEqual([]);
    const unreasoned = PANEL_ALLOWLIST.filter((a) => a.reason.trim().length < 20).map((a) => a.file);
    expect(unreasoned).toEqual([]);
  });

  it('every allowlist entry points at a file that still has a mapped block', () => {
    // Staleness, the same idiom the sibling shadow component guard uses: an entry
    // whose file was deleted or converted must be deleted with it, so the list
    // SHRINKS as the dead-code pass and step 6 land. Without this the allowlist
    // silently becomes a list of files nobody can prove anything about, and the
    // next reader cannot tell a live exception from a fossil.
    const mapped = new Set(blocks.filter((b) => b.mapped).map((b) => b.file));
    const stale = MAPPED_ALLOWLIST.filter((a) => !mapped.has(a.file)).map(
      (a) => `${a.file}: allowlisted, but no mapped <SelectContent> remains - delete this entry.`,
    );
    expect(stale).toEqual([]);
  });

  it('every allowlist entry carries a reason', () => {
    const unreasoned = MAPPED_ALLOWLIST.filter((a) => a.reason.trim().length < 20).map((a) => a.file);
    expect(unreasoned).toEqual([]);
  });
});

// --- asserted examples (lock the regexes themselves) --------------------------

describe('dropdown-bypass-guard helpers (asserted examples)', () => {
  function countNative(src: string): number {
    return (stripComments(src).match(NATIVE_SELECT_RE) ?? []).length;
  }

  it('NATIVE_SELECT_RE catches `<select>`, `<select ` AND the attributes-on-next-line form', () => {
    expect(countNative('<select>')).toBe(1);
    expect(countNative('<select className="x">')).toBe(1);
    // The form both removed native selects were written in - a naive
    // `<select[ >]` misses this one.
    expect(countNative('<select\n  value={v}\n  onChange={f}\n>')).toBe(1);
    expect(countNative('<select/>')).toBe(1);
    expect(countNative('<select><option /></select><select\n  value={v}\n/>')).toBe(2);
  });

  it('NATIVE_SELECT_RE does not match <Select>, <SelectContent> or <selectable>', () => {
    expect(countNative('<Select><SelectContent /></Select>')).toBe(0);
    expect(countNative('<selectable />')).toBe(0);
  });

  it('stripComments preserves line numbering, so a failure names the real line', () => {
    const src = '/* a\n   multi-line\n   comment */\n<select />';
    expect(stripComments(src).split('\n')).toHaveLength(4);
    expect(stripComments(src).split('\n')[3]).toBe('<select />');
  });

  it('comments describing a removed <select> do not trip check 1', () => {
    // Verbatim shapes present in the tree at seed time.
    expect(countNative('// A custom dropdown (not a native <select>) so the panel matches.')).toBe(0);
    expect(countNative('/**\n * Radix Select rather than a native <select>.\n */')).toBe(0);
    // A fragment mid-block only strips when its delimiters are present, which
    // is how it appears in the tree (assetsView.tsx's leading doc block).
    expect(
      countNative('/**\n *   - the native `<select>` becomes a kit Select.\n */'),
    ).toBe(0);
    // ...but a real element on the line after a comment still counts.
    expect(countNative('// not a native <select>\n<select value={v} />')).toBe(1);
  });

  it('SELECT_CONTENT_BLOCK_RE reads one block at a time and sees a multi-line body', () => {
    const src = `
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
      <SelectContent>
        <SelectItem value="a">A</SelectItem>
      </SelectContent>
    `;
    SELECT_CONTENT_BLOCK_RE.lastIndex = 0;
    const found = src.match(SELECT_CONTENT_BLOCK_RE) ?? [];
    expect(found).toHaveLength(2);
    expect(/\.map\(/.test(found[0]!)).toBe(true);
    expect(/\.map\(/.test(found[1]!)).toBe(false);
  });

  it('SELECT_ITEM_RE counts literal children only, and is word-boundaried', () => {
    const literal = '<SelectContent><SelectItem /><SelectItem value="b">B</SelectItem></SelectContent>';
    expect((literal.match(SELECT_ITEM_RE) ?? []).length).toBe(2);
    // A mapped block has ONE literal <SelectItem> - the template inside the
    // callback - which is why the two checks read different signals.
    const mapped = '<SelectContent>{xs.map((x) => <SelectItem key={x} />)}</SelectContent>';
    expect((mapped.match(SELECT_ITEM_RE) ?? []).length).toBe(1);
    expect(('<SelectItemGroup />'.match(SELECT_ITEM_RE) ?? []).length).toBe(0);
  });

  it('POPOVER_CONTENT_BLOCK_RE reads one block at a time and sees a multi-line body', () => {
    const src = `
      <PopoverContent align="start">
        {rows.map((r) => <Row key={r.id} {...r} />)}
      </PopoverContent>
      <PopoverContent><p>nothing mapped</p></PopoverContent>
    `;
    POPOVER_CONTENT_BLOCK_RE.lastIndex = 0;
    const found = src.match(POPOVER_CONTENT_BLOCK_RE) ?? [];
    expect(found).toHaveLength(2);
    expect(/\.map\(/.test(found[0]!)).toBe(true);
    expect(/\.map\(/.test(found[1]!)).toBe(false);
  });

  it('ROW_MUTATION_RE reads the icons AND the aria-label forms, in both quote styles', () => {
    expect(ROW_MUTATION_RE.test('<Pencil className="h-3 w-3" />')).toBe(true);
    expect(ROW_MUTATION_RE.test('<Trash2 />')).toBe(true);
    expect(ROW_MUTATION_RE.test('aria-label={`Delete ${c.name}`}')).toBe(true);
    expect(ROW_MUTATION_RE.test('aria-label="Edit location"')).toBe(true);
    // Not a mutation affordance: a component whose name merely starts the same,
    // and an unrelated aria-label.
    expect(ROW_MUTATION_RE.test('<PencilRuler />')).toBe(false);
    expect(ROW_MUTATION_RE.test('aria-label="Editorial notes"')).toBe(false);
    expect(ROW_MUTATION_RE.test('<Check /><ChevronDown />')).toBe(false);
  });

  it('check 4 goes red on a planted panel: proven by running the real assertion', () => {
    // Not "would fail" - DOES fail. The same demonstration the raw-tag ratchet
    // gives itself: build the violation, run the vitest assertion the guard
    // runs, and require it to throw.
    const planted: PanelHit[] = [{ file: 'components/vendors/VendorPill.tsx', line: 42 }];
    const allowed = new Set(PANEL_ALLOWLIST.map((a) => a.file));
    const violations = planted
      .filter((p) => !allowed.has(p.file))
      .map((p) => `${p.file}:${p.line}: hand-composed <PopoverContent> mapping entity rows`);
    expect(() => expect(violations, PANEL_HELP).toEqual([])).toThrow();
    // ...and an allowlisted file in the same position does NOT throw.
    const excused: PanelHit[] = [{ file: PANEL_ALLOWLIST[0]!.file, line: 42 }];
    expect(excused.filter((p) => !allowed.has(p.file))).toEqual([]);
  });

  it('the threshold is read from the single declaration, not hardcoded here', () => {
    expect(SEARCH_THRESHOLD).toBe(10);
  });
});
