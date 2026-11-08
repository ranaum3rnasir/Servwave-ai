import { CustomFieldEntity } from '@prisma/client';
import { prisma } from './prisma';

export type CustomFieldValues = Record<string, unknown>;

/** Thrown by validateCustomFieldValues - callers translate it into a 400. */
export class CustomFieldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomFieldValidationError';
  }
}

/**
 * Shallow-merges a patch of custom-field values onto an entity's existing `custom_fields`
 * JSON bag. Never mutates `existing` - callers (e.g. job.controller.ts's update()) still hold
 * the pre-edit row for other comparisons in the same request.
 *
 * An explicit `null` in the patch deletes that key rather than storing `null`, so a value
 * cleared once and never re-set does not linger in the JSON blob.
 */
export function mergeCustomFields(
  existing: CustomFieldValues | null | undefined,
  patch: CustomFieldValues,
): CustomFieldValues {
  const merged: CustomFieldValues = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Validates a custom-field patch against the org's definitions before it is ever merged into a
 * Prisma write. Throws CustomFieldValidationError on the first problem found:
 *  - a key that is not one of the org's own CustomFieldDefinition ids (also catches a
 *    definition id borrowed from another org - tenant-scoped by construction, `where` never
 *    trusts the caller past this org's own rows)
 *  - a definition that does not apply to `entityType`
 *  - a non-null value against an archived definition (clearing one - an explicit `null` - is
 *    still allowed, so a stale value can always be removed even after the field is retired)
 *  - a value whose shape does not match the definition's type - only TEXT (a string) is
 *    exercised end to end this slice, so every other CustomFieldType is rejected here rather
 *    than silently accepted; widening this is a later slice's job.
 */
export async function validateCustomFieldValues(
  organizationId: string,
  entityType: CustomFieldEntity,
  patch: CustomFieldValues,
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;

  const definitions = await prisma.customFieldDefinition.findMany({
    where: { organization_id: organizationId, id: { in: keys } },
    select: { id: true, entity_types: true, type: true, archived_at: true },
  });
  const byId = new Map(definitions.map((d) => [d.id, d]));

  for (const key of keys) {
    const definition = byId.get(key);
    if (!definition) {
      throw new CustomFieldValidationError(`Unknown custom field: ${key}`);
    }
    if (!definition.entity_types.includes(entityType)) {
      throw new CustomFieldValidationError(`Custom field ${key} does not apply to this entity type`);
    }

    const value = patch[key];
    if (value === null) continue; // clearing a value is always allowed, even if archived

    if (definition.archived_at) {
      throw new CustomFieldValidationError(`Custom field ${key} is archived`);
    }
    if (definition.type !== 'TEXT') {
      throw new CustomFieldValidationError(`Custom field ${key} does not support type ${definition.type} yet`);
    }
    if (typeof value !== 'string') {
      throw new CustomFieldValidationError(`Custom field ${key} must be a string`);
    }
  }
}
