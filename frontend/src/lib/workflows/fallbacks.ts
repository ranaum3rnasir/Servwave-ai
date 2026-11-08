/**
 * "If empty, fill with" as the step forms hold it.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 *
 * A send step's config may carry `fallbacks: { [field]: text }`. The server reads an ABSENT map as
 * the seeded default set and a PRESENT map as-is (a missing key is an empty field), so the form
 * mirrors that exactly: it emits no map until the author touches one, and the first edit emits
 * the whole displayed map (the defaults plus the edit) rather than a single key.
 */
import type { WorkflowCatalog } from '@/lib/api/workflows';

/** The map a stored config carries, or undefined when it has none. */
export function storedFallbacks(config: Record<string, unknown>): Record<string, string> | undefined {
  const raw = config.fallbacks;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [field, text] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof text === 'string') out[field] = text;
  }
  return out;
}

/**
 * What the popovers display: the catalog's seeded defaults, with the stored map over the top.
 *
 * MERGED, NOT "stored ?? defaults" (Ran, 2026-09-15). Every stored map is a SNAPSHOT of the
 * defaults as they stood when it was written - the seeder writes one into every seeded step, and
 * this form emits the whole displayed map on the author's first edit - so a default added later
 * reaches none of them under `??`, and the popover would show an empty box for a field that has a
 * default. Worse, the SERVER would then render that field with no fallback at all, which is a
 * hole in a customer's email. `fallbacksFor` on the backend merges the same way and this mirrors
 * it exactly: the two must agree, or the box shows one thing and the send does another.
 *
 * A CLEARED fallback still wins, because clearing stores the key with '' rather than deleting it
 * (see the caller in sendEmailForm.tsx, which spreads the displayed map and overwrites one key).
 */
export function displayedFallbacks(
  stored: Record<string, string> | undefined,
  catalog: WorkflowCatalog | undefined,
): Record<string, string> {
  return { ...(catalog?.default_fallbacks ?? {}), ...(stored ?? {}) };
}
