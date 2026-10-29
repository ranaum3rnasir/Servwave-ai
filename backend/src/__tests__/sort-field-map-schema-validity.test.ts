/**
 * SRVW-89 - every value in every SORT_FIELD_MAPS registry entry must name a real,
 * non-relation, non-list field on its Prisma model. Modelled on
 * default-grants-schema-validity.test.ts (#918/#925): that suite proved a condition shape
 * naming a renamed/absent relation throws PrismaClientValidationError and 500s at the
 * controller's catch-all. The same failure mode applies here - Customers allowlisted `company`
 * (the real field is `company_name`) and price-book allowlisted `item_type` (the real field is
 * `type`), and both 500 in production the moment someone sorts by them.
 *
 * NOT a scalar-only check: `status` is kind='enum' on Job/Estimate/Lead/Invoice/Asset and `type`
 * is kind='enum' on PriceBookItem, so `field.kind === 'scalar'` would falsely reject 8 real,
 * sortable entries. Mirroring the precedent's relation detector, the predicate is: the field
 * must exist, `kind !== 'object'` (that is what marks a relation), and `isList === false`.
 */
import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { SORT_FIELD_MAPS } from '../lib/sortFields';

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

function fieldError(modelName: string, fieldName: string): string | null {
  const model = models.get(modelName);
  if (!model) return `no Prisma model named '${modelName}'`;
  const field = model.fields.find((f) => f.name === fieldName);
  if (!field) return `'${fieldName}' does not exist on model '${modelName}'`;
  if (field.kind === 'object') return `'${fieldName}' on '${modelName}' is a relation, not a sortable field`;
  if (field.isList) return `'${fieldName}' on '${modelName}' is a list field, not sortable`;
  return null;
}

describe('SORT_FIELD_MAPS values name real, non-relation, non-list Prisma fields', () => {
  it('covers a meaningful number of registry entries (guards against a vacuous pass)', () => {
    expect(SORT_FIELD_MAPS.length).toBeGreaterThanOrEqual(9);
  });

  for (const { model, map } of SORT_FIELD_MAPS) {
    for (const [columnId, fields] of Object.entries(map)) {
      for (const field of fields) {
        it(`${model}.${field} (column id '${columnId}') is a real sortable field`, () => {
          expect(fieldError(model, field)).toBeNull();
        });
      }
    }
  }

  it('negative case: a fake field is reported as an error', () => {
    expect(fieldError('Customer', 'company')).not.toBeNull();
  });

  it('negative case: a relation field is reported as an error', () => {
    expect(fieldError('Job', 'customer')).not.toBeNull();
  });
});
