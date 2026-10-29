/**
 * DESIGN_SYSTEM.md §4.2 - "the 10-option rule": a dropdown with 10 or more
 * options is a searchable combobox, fewer than 10 is a plain select.
 *
 * THIS IS THE ONLY DECLARATION OF THE NUMBER IN THE CODEBASE, and
 * `frontend/src/components/form/__tests__/select-field.test.tsx` fails the build
 * if a second one appears. Both family entry points read it from here:
 *
 *   - `@/components/form/SelectField`            (app family - components/ui/select)
 *   - `@/ui-kit/components/form/selectField`     (kit family - ui-kit/components/ui/select)
 *
 * Each reads `options.length` at render time, so no call site declares anything.
 * That single read is what makes the rule retroactive, automatic over the
 * customer's data (six vendors vs sixty), and automatic over time (a fixed list
 * that grows to ten becomes searchable on the commit that grows it).
 *
 * It lives in `ui-kit/lib` rather than beside either entry point because the app
 * may import from `@/ui-kit/...` but nothing under `ui-kit/` may import back
 * out. Kept dependency-free so importing the number never drags a component in.
 */
export const SEARCH_THRESHOLD = 10;
