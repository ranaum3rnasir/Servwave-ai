/**
 * entities.ts - the business entities a trigger can hang off, and the order the
 * builder groups them in. Mirrors backend/src/services/automations/
 * automationEntity.ts's `AutomationEntity`.
 *
 * DECLARED here rather than derived from `TriggerDef['entity']`, and the direction of that
 * dependency is now inverted: `lib/api/workflows.ts` reads this type instead of spelling the
 * union out again. Two reasons.
 *
 * First, this file is a leaf with no imports, so the pure builder modules (triggerModel.ts)
 * can name the same type without reaching through the API layer.
 *
 * Second, ENTITY_ORDER below is an ARRAY LITERAL, and an array literal is the one shape the
 * compiler cannot police: a five-member union with a four-member array typechecks perfectly,
 * so a new entity's tile would simply never render, with nothing going red anywhere. Keeping
 * the union and the order side by side is what makes the omission visible to a reader, since
 * it cannot be made visible to `tsc`.
 */

export type AutomationEntity = 'job' | 'estimate' | 'invoice' | 'lead' | 'task';

/** Every member of AutomationEntity, in builder order. Keep these two in step BY HAND. */
export const ENTITY_ORDER: AutomationEntity[] = ['job', 'estimate', 'invoice', 'lead', 'task'];
