import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

/**
 * #918 — a `role_permissions.conditions` template is spread verbatim into a Prisma `where`
 * by scopeWhereFor. If it names a field or relation that does not exist, Prisma throws
 * PrismaClientValidationError and the controller's catch-all returns 500. That is exactly how
 * `{"lead":{"assigned_user":…}}` survived the `assigned_user` -> `lead_assignees` rename and
 * took out the SALES role's Estimates and Jobs list pages in production-like environments.
 *
 * Nothing caught it because the existing permission tests use FABRICATED condition shapes
 * (define-ability-scope.test.ts asserts on `assigned_user`/`assigned_to` fixtures) and only
 * exercise token substitution — never whether the shape is real. This test closes that gap by
 * walking every DEFAULT_GRANTS condition against the generated Prisma schema, so the next
 * relation rename fails CI instead of a customer's list page.
 */

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

// Prisma filter keys that wrap a nested where on the CURRENT model rather than naming a field.
const RELATION_FILTERS = new Set(['some', 'every', 'none', 'is', 'isNot']);
const LOGICAL_FILTERS = new Set(['AND', 'OR', 'NOT']);

/**
 * Walk a condition object against `modelName`, collecting human-readable errors for any key
 * that is not a real field/relation on that model. Returns [] when the shape is valid.
 */
function invalidPaths(modelName: string, condition: unknown, path = modelName): string[] {
  const model = models.get(modelName);
  if (!model) return [`${path}: no Prisma model named '${modelName}'`];
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return [];

  const errors: string[] = [];
  for (const [key, value] of Object.entries(condition as Record<string, unknown>)) {
    if (LOGICAL_FILTERS.has(key)) {
      const branches = Array.isArray(value) ? value : [value];
      branches.forEach((b, i) => errors.push(...invalidPaths(modelName, b, `${path}.${key}[${i}]`)));
      continue;
    }
    if (RELATION_FILTERS.has(key)) {
      errors.push(...invalidPaths(modelName, value, `${path}.${key}`));
      continue;
    }

    const field = model.fields.find((f) => f.name === key);
    if (!field) {
      errors.push(`${path}.${key} — '${key}' is not a field or relation on model '${modelName}'`);
      continue;
    }
    // Relation field: descend into the related model. Scalar field: the value is a literal or a
    // scalar filter, neither of which can name a bad relation, so stop here.
    if (field.kind === 'object') {
      errors.push(...invalidPaths(field.type, value, `${path}.${key}`));
    }
  }
  return errors;
}

/**
 * Every conditioned grant in DEFAULT_GRANTS, regardless of subject. Originally scoped to just
 * scopeWhereFor's ScopeResource union (Lead/Job/Estimate/Invoice/LogisticOrder) — the subjects
 * where a bad shape becomes a Prisma 500 — with `Notification` deliberately excluded because its
 * OWN_NOTIFICATION condition didn't compile either (`recipient_id` lives on NotificationRecipient,
 * not Notification) and fixing it was mixed scope for the #918 outage fix.
 *
 * #925 corrected OWN_NOTIFICATION and removed that exclusion: every conditioned grant is now
 * schema-checked, not just the ones that reach a Prisma `where` today. A future subject joining
 * ScopeResource needs no test change — it was already covered.
 */
const conditioned = DEFAULT_GRANTS.filter((g) => g.conditions != null);

describe('DEFAULT_GRANTS conditions compile against the Prisma schema (#918, #925)', () => {
  it('covers a meaningful number of conditioned grants (guards against a vacuous pass)', () => {
    // If a refactor empties DEFAULT_GRANTS or drops every condition, the per-grant assertions
    // below would all pass trivially. Anchor the suite so that silent evaporation fails loudly.
    expect(conditioned.length).toBeGreaterThan(20);
  });

  it.each(conditioned.map((g) => [`${g.role} ${g.action} ${g.subject}`, g] as const))(
    '%s — condition names only real fields/relations',
    (_label, grant) => {
      expect(models.has(grant.subject)).toBe(true);
      expect(invalidPaths(grant.subject, grant.conditions)).toEqual([]);
    },
  );

  // ── The validator must have teeth ──────────────────────────────────────────────
  // A checker that never rejects anything would make every assertion above vacuous. These
  // negative cases pin the exact drifted shapes from #918 as things that MUST be rejected.

  it('rejects the historical drifted SALES read Estimate shape', () => {
    const errors = invalidPaths('Estimate', { lead: { assigned_user: { department_id: '{{teamId}}' } } });
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('assigned_user');
  });

  it('rejects the historical drifted SALES read Job shape', () => {
    const errors = invalidPaths('Job', { assigned_user: { department_id: '{{teamId}}' } });
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('assigned_user');
  });

  it('rejects a bad field nested under a relation filter', () => {
    const errors = invalidPaths('Estimate', {
      lead: { lead_assignees: { some: { nope_not_a_column: '{{userId}}' } } },
    });
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('nope_not_a_column');
  });

  it('accepts the corrected own-scoped shapes the repair migration writes', () => {
    expect(invalidPaths('Estimate', { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } })).toEqual([]);
    expect(invalidPaths('Job', { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } })).toEqual([]);
    expect(invalidPaths('Invoice', { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } })).toEqual([]);
    expect(invalidPaths('Lead', { lead_assignees: { some: { user_id: '{{userId}}' } } })).toEqual([]);
  });

  // #925 — pins the historical drifted OWN_NOTIFICATION shape (pre-recipients-split) as
  // rejected, and the corrected shape as accepted.
  it('rejects the historical drifted OWN_NOTIFICATION shape', () => {
    const errors = invalidPaths('Notification', { recipient_id: '{{userId}}' });
    expect(errors).not.toEqual([]);
    expect(errors.join(' ')).toContain('recipient_id');
  });

  it('accepts the corrected OWN_NOTIFICATION shape', () => {
    expect(invalidPaths('Notification', { recipients: { some: { recipient_id: '{{userId}}' } } })).toEqual([]);
  });
});
