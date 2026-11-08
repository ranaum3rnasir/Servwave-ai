/* =============================================================================
   ServWave shared-component library — shadow-component guard (regression fence)
   -----------------------------------------------------------------------------
   Enforces invariant I2: "no concept has two implementations (one shared, one
   local)". It exists because of a real bug: `src/components/communication/
   phone/shared.tsx` exported a hand-rolled `Toggle` (raw `<button role="switch">`,
   no focus ring, no disabled state, `rounded-full` instead of the `rounded-pill`
   token) that quietly duplicated `src/components/ui/switch.tsx`. Nothing failed
   loudly - the app just grew two toggle switches that drift independently.

   WHAT IT DOES
     1. Walks src/components/**, src/pages/**, src/features/**, excluding
        src/components/ui/** (the primitives themselves), __tests__ dirs, and
        test/spec files (*.test.ts(x), *.spec.ts(x)).
     2. Finds exported components whose name contains Button, Modal, Dialog,
        Toggle, or Switch - i.e. names that claim to BE one of those concepts -
        whether exported where declared or at the bottom (`export { X }`).
     3. For each, checks whether the file actually composes the matching shared
        primitive (imports it from components/ui AND renders its JSX tag) rather
        than reimplementing the concept from raw markup.
     4. A component that doesn't compose the primitive is a violation UNLESS its
        name+file pair is in ALLOWLIST below, each entry carrying an honest,
        specific reason.

   CONCEPT MAPPING (why Dialog and Modal share one bucket)
     `ui/modal.tsx` is documented as composing `ui/dialog.tsx` ("Composes ui/
     dialog rather than replacing it; reach for the raw Dialog primitives only
     when a surface needs a layout this does not cover"). A component named
     "...Dialog" that renders <Modal>, or one named "...Modal" that renders
     <Dialog> directly, is NOT a shadow implementation - it is correctly reaching
     for the shared surface at whichever layer fits. So Modal and Dialog check
     against the SAME primitive/tag pair: {modal, dialog} / {<Modal>, <Dialog>}.
     `ui/confirm-dialog.tsx` composes `ui/dialog.tsx` the same way, for the
     confirm-flavored case (icon badge, Cancel/Confirm footer, loading state) -
     it joins the same bucket: {modal, dialog, confirm-dialog} / {<Modal>,
     <Dialog>, <ConfirmDialog>}.

     Toggle checks against {switch, toggle-group} / {<Switch>, <ToggleGroup>}.
     No ui/toggle-group.tsx exists in this codebase yet - the alternation is
     kept so the guard doesn't need editing the day one is added; until then
     `switch` is the only real target for a "Toggle"-named export.

   SEEDING THE ALLOWLIST
     Run against the real tree at seed time, ALLOWLIST contains every current
     instance that doesn't compose its primitive - including genuine pre-
     existing duplicates, not just false positives. The point is a green fence
     from day one that shrinks as entries get consolidated or deleted, not a
     retroactive cleanup gate. See each entry's reason for which kind it is.

   KNOWN LIMITATION
     The detection regex (below, verbatim from the spec) matches `export const
     use<...>Toggle` the same as a component - it doesn't distinguish hooks from
     components. No such hook exists in the tree today (checked at seed time);
     if one is ever added, allowlist it rather than widening the regex, so the
     allowlist keeps a record of every exception instead of the regex quietly
     losing precision.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo-root-relative anchor: this file lives at
// frontend/src/design-system/__tests__/, so frontend/src is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..');
const UI_DIR = join(SRC, 'components', 'ui');

/** Recursively list .ts/.tsx files under a dir, skipping components/ui,
 *  __tests__ dirs, and test/spec files. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (name === '__tests__') return [];
    if (p === UI_DIR) return [];
    if (statSync(p).isDirectory()) return walk(p);
    if (/\.(test|spec)\.(ts|tsx)$/.test(p)) return [];
    return /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

/** Strip line + block comments so a commented-out `<Dialog>` or import doesn't
 *  false-negative a violation (and a commented-out export name doesn't false-
 *  positive one).
 *
 *  Line comments are stripped FIRST, deliberately - not tokens-guard.test.ts's
 *  order. A line comment can itself contain a stray comment-opener-looking
 *  substring (e.g. a URL path segment ending in "/*"); running the block-
 *  comment regex first treats that as a real comment opener and swallows
 *  everything up to the next unrelated comment-closer in the file, silently
 *  deleting real code (this actually happened here: it ate the Modal render
 *  in two inventory dialogs and produced false violations). Stripping line
 *  comments first removes the fake opener before the block regex sees it. */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:])\/\/.*$/gm, '$1') // keep the `:` of `http://`-style strings
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

const ROOTS = ['components', 'pages', 'features']
  .map((d) => join(SRC, d))
  .filter(existsSync);

/** Exported-name pattern, verbatim from the spec. */
const NAME_RE =
  /export\s+(default\s+)?(function|const)\s+(\w*(?:Button|Modal|Dialog|Toggle|Switch)\w*)/g;

/** A name that claims one of the five concepts. */
const CONCEPT_NAME_RE = /^\w*(?:Button|Modal|Dialog|Toggle|Switch)\w*$/;

/**
 * The declare-then-export forms NAME_RE cannot see: an export list (`export { A, B as C }`, not a
 * re-export `... from '...'`, whose implementation lives and is checked in its own file) and a bare
 * default export (`export default A;`). Declaring with `function` and exporting at the bottom
 * used to dodge the guard entirely (code review #15).
 */
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}(?!\s*from\b)/g;
const EXPORT_DEFAULT_NAME_RE = /export\s+default\s+(\w+)\s*;/g;

/** Every concept-named export in `code`, in any of the three forms, each once. */
function exportedConceptNames(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(NAME_RE)) names.push(m[3]!);
  for (const m of code.matchAll(EXPORT_LIST_RE)) {
    for (const item of m[1]!.split(',')) {
      const spec = item.trim();
      if (!spec || /^type\s/.test(spec)) continue;
      const exported = spec.split(/\s+as\s+/).pop()!.trim();
      if (CONCEPT_NAME_RE.test(exported)) names.push(exported);
    }
  }
  for (const m of code.matchAll(EXPORT_DEFAULT_NAME_RE)) {
    if (CONCEPT_NAME_RE.test(m[1]!)) names.push(m[1]!);
  }
  return [...new Set(names)];
}

type Concept = 'Button' | 'Modal' | 'Dialog' | 'Toggle' | 'Switch';

const CONCEPT_PRIMITIVES: Record<Concept, { primitives: string[]; tags: string[] }> = {
  Button: { primitives: ['button'], tags: ['Button'] },
  Modal: { primitives: ['modal', 'dialog', 'confirm-dialog'], tags: ['Modal', 'Dialog', 'ConfirmDialog'] },
  Dialog: { primitives: ['modal', 'dialog', 'confirm-dialog'], tags: ['Modal', 'Dialog', 'ConfirmDialog'] },
  Toggle: { primitives: ['toggle-group', 'switch'], tags: ['ToggleGroup', 'Switch'] },
  Switch: { primitives: ['switch'], tags: ['Switch'] },
};

/** Which of the five concepts appear as substrings of an exported name. */
function conceptsInName(name: string): Concept[] {
  return (Object.keys(CONCEPT_PRIMITIVES) as Concept[]).filter((c) => name.includes(c));
}

/**
 * The kit's name for each legacy primitive, or null where it ships none.
 *
 * The v2 presentation layer composes `@/ui-kit/components/ui/*`, not
 * `@/components/ui/*`. Both are shared primitives, so a v2 file building a
 * dialog out of the kit's dialog is doing exactly what this guard asks for -
 * but it read as a hand-rolled shadow, because the guard only knew one root.
 *
 * The workaround modules found was to declare with `function` and export at the
 * bottom, dodging NAME_RE entirely. That silences the guard rather than
 * satisfying it, and it was spreading: four modules had adopted it before this
 * was fixed. `exportedConceptNames` now reads that form too.
 *
 * Filenames differ between the two: the app is kebab-case, the kit is
 * camelCase. `modal` and `toggle-group` map to null because the kit ships
 * neither - a file named ...Modal is compliant via the kit's `dialog`, which
 * the Modal concept already accepts.
 */
const KIT_PRIMITIVE: Record<string, string | null> = {
  button: 'button',
  dialog: 'dialog',
  'confirm-dialog': 'confirmDialog',
  switch: 'switch',
  modal: null,
  'toggle-group': null,
};

function importsPrimitive(code: string, primitive: string): boolean {
  if (new RegExp(`from\\s+['"]@/components/ui/${primitive}['"]`).test(code)) return true;

  const kitName = KIT_PRIMITIVE[primitive];
  return !!kitName && new RegExp(`from\\s+['"]@/ui-kit/components/ui/${kitName}['"]`).test(code);
}

/** A JSX open/self-close of `tag`, e.g. `<Dialog>`/`<Dialog `/`<Dialog/>` -
 *  but NOT `<DialogContent>` (word-boundary via the trailing char class). */
function rendersTag(code: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s/>]`).test(code);
}

/** Compliant if, for at least one concept present in the name, the file both
 *  imports the matching primitive AND renders the matching tag. */
function isCompliant(code: string, name: string): boolean {
  return conceptsInName(name).some((concept) => {
    const { primitives, tags } = CONCEPT_PRIMITIVES[concept];
    return primitives.some((p) => importsPrimitive(code, p)) && tags.some((t) => rendersTag(code, t));
  });
}

interface Match {
  file: string; // absolute path
  name: string;
  compliant: boolean;
}

function findMatches(): Match[] {
  const matches: Match[] = [];
  for (const file of ROOTS.flatMap(walk)) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const name of exportedConceptNames(code)) {
      matches.push({ file, name, compliant: isCompliant(code, name) });
    }
  }
  return matches;
}

function relFile(file: string): string {
  return relative(SRC, file).split('\\').join('/'); // posix-normalize on Windows
}

// --- the allowlist -------------------------------------------------------------
// Seeded from the current tree (see file header). Every entry: exported name,
// its file (relative to frontend/src), and a one-line honest reason - either
// "this is a deliberately different variant, not a duplicate" or "this is real
// debt, not yet consolidated".

interface AllowlistEntry {
  name: string;
  file: string; // relative to frontend/src
  reason: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    name: 'SendInvoiceDialog',
    file: 'components/invoices/SendInvoiceDialog.tsx',
    reason:
      'renders as a slide-over via ui/sheet (itself Radix-Dialog-based), not the centered Dialog/Modal - a genuinely different variant (side panel), not a duplicate concept',
  },
  {
    name: 'AddStepButton',
    file: 'components/workflows/AddStepButton.tsx',
    reason:
      "Popover-trigger control with three bespoke visual treatments (rail dot / dashed empty well / dashed inline chip) outside Button's variant vocabulary; composes Popover, not a hand-rolled dialog - not a duplicate of the Button primitive",
  },
  {
    name: 'ConflictModal',
    file: 'pages/v2/schedule/components/conflictModal.tsx',
    reason:
      'DELIBERATELY hand-rolled, not composing ui/dialog - documented at its one call site (SchedulePage.tsx): it can be set from inside an already-open EventEditor on a live 409, and EventEditor\'s own Dialog is gated `!conflictToast && !unscheduleConfirm` specifically so a Radix dialog is never mounted at the same tick as this overlay, avoiding a focus-lock fight between two Radix dialogs. Carries hand-rolled role="alertdialog"/aria-modal/aria-label and focus-in/focus-restore instead. Not a duplicate concept - a documented workaround for a real Radix limitation, same shape as the sibling "Nobody is assigned" and unschedule-confirm overlays in the same file (which predate this guard and are not separately-exported components).',
  },
];

// --- the guard ----------------------------------------------------------------

describe('shadow-component guard (no concept has two implementations - I2)', () => {
  const matches = findMatches();

  it('scans a non-trivial, expected set of concept-named exports', () => {
    expect(matches.length).toBeGreaterThan(20);
    // sanity: known compliant and known-allowlisted instances are both present
    expect(matches.some((m) => m.name === 'CancelEstimateDialog')).toBe(true);
    expect(matches.some((m) => m.name === 'ManageDirectoryModal')).toBe(true);
    // Declared, then exported at the bottom (`export { X }`): scanned too, not skipped.
    for (const name of ['TaskCategoriesDialog', 'CreateTaskCategoryDialog', 'DeleteTaskCategoryDialog']) {
      expect(matches.some((m) => m.name === name), name).toBe(true);
    }
  });

  it('every allowlist entry points at a real export in a real file', () => {
    const bad = ALLOWLIST.filter(({ file, name }) => {
      const abs = join(SRC, file);
      if (!existsSync(abs)) return true;
      return !matches.some((m) => m.file === abs && m.name === name);
    });
    expect(bad).toEqual([]);
  });

  it('every allowlist entry is still needed (would otherwise be flagged)', () => {
    // Catches stale entries: if a file gets fixed to compose its primitive,
    // its allowlist entry should be deleted, not left as dead weight. This is
    // the mechanism that makes the fence "shrink over time".
    const stillViolating = new Set(
      matches.filter((m) => !m.compliant).map((m) => `${relFile(m.file)}::${m.name}`),
    );
    const stale = ALLOWLIST.filter((a) => !stillViolating.has(`${a.file}::${a.name}`));
    expect(stale).toEqual([]);
  });

  it('no non-allowlisted export shadow-implements a shared ui/ primitive', () => {
    const allowed = new Set(ALLOWLIST.map((a) => `${a.file}::${a.name}`));
    const violations = matches
      .filter((m) => !m.compliant)
      .filter((m) => !allowed.has(`${relFile(m.file)}::${m.name}`))
      .map((m) => `${relFile(m.file)}: ${m.name}`);
    expect(violations).toEqual([]);
  });
});

// --- asserted examples (lock the regexes themselves) --------------------------

describe('shadow-component-guard helpers (asserted examples)', () => {
  it('NAME_RE captures Button/Modal/Dialog/Toggle/Switch exports, function or const, default or named', () => {
    const cases: [string, string][] = [
      ['export function SaveButton() {}', 'SaveButton'],
      ['export const ConfirmModal = () => {}', 'ConfirmModal'],
      ['export default function CancelDialog() {}', 'CancelDialog'],
      ['export const useIsOpen = () => {}', ''], // no concept keyword -> not captured
    ];
    for (const [src, expected] of cases) {
      NAME_RE.lastIndex = 0;
      const m = NAME_RE.exec(src);
      expect(m?.[3] ?? '').toBe(expected);
    }
  });

  it('exportedConceptNames also reads the declare-then-export forms (code review #15)', () => {
    // A component declared with `function` and exported at the bottom used to dodge NAME_RE, and
    // with it the whole guard. The export list and a bare default export name it just the same.
    expect(exportedConceptNames('function A() {}\nexport { ThingDialog, useThing, OtherModal as PublicModal };'))
      .toEqual(['ThingDialog', 'PublicModal']);
    expect(exportedConceptNames('function SaveButton() {}\nexport default SaveButton;')).toEqual(['SaveButton']);
    // A re-export is someone else's implementation, checked in its own file; a type is not a component.
    expect(exportedConceptNames("export { ArchiveDialog } from './archiveDialog';")).toEqual([]);
    expect(exportedConceptNames('export { type ThingDialogProps, ThingDialog };')).toEqual(['ThingDialog']);
    expect(exportedConceptNames('export type { ThingDialogProps };')).toEqual([]);
    // The declaration form is still read, once.
    expect(exportedConceptNames('export function CancelDialog() {}')).toEqual(['CancelDialog']);
  });

  it('conceptsInName finds every concept substring present, even hook-like names', () => {
    expect(conceptsInName('SaveButton')).toEqual(['Button']);
    expect(conceptsInName('ArchiveDialog')).toEqual(['Dialog']);
    // documents the known limitation from the file header: substring match, no
    // hook/component distinction.
    expect(conceptsInName('useFooToggle')).toEqual(['Toggle']);
  });

  it('rendersTag requires a word boundary, so it does not match compound tags', () => {
    expect(rendersTag('<Dialog open={o}>', 'Dialog')).toBe(true);
    expect(rendersTag('<Dialog/>', 'Dialog')).toBe(true);
    expect(rendersTag('<DialogContent>', 'Dialog')).toBe(false);
  });

  it('isCompliant accepts Modal composing ui/dialog directly and Dialog-named composing ui/modal', () => {
    const usesDialogDirectly = `
      import { Dialog, DialogContent } from '@/components/ui/dialog';
      export function ThingModal() { return <Dialog><DialogContent /></Dialog>; }
    `;
    expect(isCompliant(usesDialogDirectly, 'ThingModal')).toBe(true);

    const usesModalWrapper = `
      import { Modal } from '@/components/ui/modal';
      export function ThingDialog() { return <Modal title="t">x</Modal>; }
    `;
    expect(isCompliant(usesModalWrapper, 'ThingDialog')).toBe(true);

    const handRolled = `
      export function ThingDialog() {
        return <div className="fixed inset-0"><div role="dialog">x</div></div>;
      }
    `;
    expect(isCompliant(handRolled, 'ThingDialog')).toBe(false);
  });

  it('accepts the kit primitives, which the v2 layer composes instead of components/ui', () => {
    const kitDialog = `
      import { Dialog, DialogContent } from '@/ui-kit/components/ui/dialog';
      export function ArchiveDialog() { return <Dialog><DialogContent /></Dialog>; }
    `;
    expect(isCompliant(kitDialog, 'ArchiveDialog')).toBe(true);

    // camelCase in the kit, kebab-case in the app - the same primitive.
    const kitConfirm = `
      import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
      export function DeleteDialog() { return <ConfirmDialog />; }
    `;
    expect(isCompliant(kitConfirm, 'DeleteDialog')).toBe(true);

    const kitSwitch = `
      import { Switch } from '@/ui-kit/components/ui/switch';
      export function NotifyToggle() { return <Switch />; }
    `;
    expect(isCompliant(kitSwitch, 'NotifyToggle')).toBe(true);

    // Still catches the real thing: a kit IMPORT does not excuse a hand-rolled
    // implementation, because the tag has to be rendered too.
    const kitImportButHandRolled = `
      import { Button } from '@/ui-kit/components/ui/button';
      export function FakeDialog() { return <div role="dialog"><Button /></div>; }
    `;
    expect(isCompliant(kitImportButHandRolled, 'FakeDialog')).toBe(false);
  });
});
