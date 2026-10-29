/**
 * automationEntity.ts - the business entities an automation can hang off, as ONE
 * named type every other module references.
 *
 * This module exists because the previous arrangement did not work. `AutomationEntity`
 * (catalog.ts) and `AudienceEntity` (recipients.ts) were the two named copies, and a
 * further nine hand-written copies of the same literal union were spread across the
 * dispatch event, the execution bundle, the anchor registry, the stop-if map, the
 * date-anchor sweep and the frontend. Spec B assumed that widening the union would be
 * "a compile error at every site"; measured, widening both named types produced exactly
 * TWO backend errors and zero elsewhere, so adding `task` could have shipped with the
 * loader, the sweep and the builder's own subject list silently four-membered.
 *
 * A leaf module with no imports, so anchors.ts (which catalog.ts imports) can reference
 * it without a cycle. Everything that names an entity imports it FROM HERE - including
 * catalog.ts and recipients.ts, which re-export it under their historic names so the
 * existing import sites keep working.
 *
 * Adding the sixth entity is now one edit here plus whatever the compiler then reddens.
 */

export type AutomationEntity = 'job' | 'estimate' | 'invoice' | 'lead' | 'task';
