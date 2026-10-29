/**
 * Limits for a line item's editable fields.
 *
 * This MUST stay in step with `LINE_DESCRIPTION_MAX` in `backend/src/lib/line-items.ts`. The
 * server is the gate; this copy exists so the dialog can stop the user at the boundary instead
 * of letting them write a long scope of work and only then bounce it off a raw Zod message
 * (#1604).
 *
 * The item name and its detail text share this ONE budget: they are stored in a single
 * `description` column as `name\ndetail`, so a counter that measured only the textarea would
 * report a number the server does not agree with.
 */
export const LINE_DESCRIPTION_MAX = 50_000;

/**
 * The exact string the API receives for a line's `description`. `splitDescription()` in
 * AddLineDialog/LineItemRow reads it back apart on the same rule.
 */
export function combineDescription(name: string, detail: string): string {
  return detail.trim() ? `${name}\n${detail.trim()}` : name;
}
