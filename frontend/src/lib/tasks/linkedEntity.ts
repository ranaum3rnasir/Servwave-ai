import type { LinkedEntity } from './types';

/**
 * What the chip's tooltip says instead of the entity's identity when the reader may not open it.
 *
 * The LABEL is already a neutral placeholder by the time it reaches us ("Restricted job" and its
 * siblings, chosen server-side in `lib/tasks/enrich.ts`); this only explains why.
 */
export const REDACTED_ENTITY_HINT = 'You do not have access to this record';

/**
 * Whether the reader holding this row may open the linked entity.
 *
 * `type` and `id` still travel on the wire for a redacted link - the chip needs the type to render
 * at all - so any surface can still BUILD a route to an entity the reader would be 403'd from.
 * This predicate is the one place that decides otherwise, so a surface that wants to make the chip
 * navigable has to come through here first.
 */
export function canOpenLinkedEntity(entity: LinkedEntity | null | undefined): boolean {
  return !!entity && !entity.redacted;
}
