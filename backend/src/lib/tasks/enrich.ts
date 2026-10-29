import { prisma } from '../prisma';
import type { AppAbility } from '../permissions/defineAbility';
import {
  entityAccessScope,
  entityRefKey,
  groupRefs,
  type EntityAccessReader,
  type EntityRef,
} from './entityAccess';

export function userFullName(u: { first_name?: string | null; last_name?: string | null }): string {
  return `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
}

export function customerLabel(c: { company_name?: string | null; first_name?: string | null; last_name?: string | null; customer_number: string }): string {
  if (c.company_name) return c.company_name;
  const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
  return person || c.customer_number;
}

/**
 * What a reader who cannot open the linked entity is shown instead of its number, its job type or
 * the customer's name (#01). Redact, do not omit: the task still has to read as attached to
 * SOMETHING, and a blank reads as a bug.
 *
 * The entity KIND is not the secret and is not redacted - `linked_entity_type` travels beside the
 * label, unchanged.
 */
export const REDACTED_ENTITY_LABELS: Record<string, string> = {
  JOB: 'Restricted job',
  LEAD: 'Restricted lead',
  ESTIMATE: 'Restricted estimate',
  CUSTOMER: 'Restricted customer',
};
export const REDACTED_ENTITY_LABEL = 'Restricted record';

export const redactedEntityLabel = (type: string): string =>
  REDACTED_ENTITY_LABELS[type] ?? REDACTED_ENTITY_LABEL;

export interface EntityLabel {
  /** The real label, the redacted placeholder, or null when the entity is simply gone. */
  label: string | null;
  redacted: boolean;
}

const visible = (label: string | null): EntityLabel => ({ label, redacted: false });
const hidden = (type: string): EntityLabel => ({ label: redactedEntityLabel(type), redacted: true });

/**
 * Labels for a whole list's linked entities, resolved ONLY within what the reader may open (#01).
 *
 * Scoping happens inside the query that fetches the label, so redaction costs no extra round trip:
 * at most one findMany per entity type for the entire list, never one per task.
 *
 * A ref the query does not return is one of two different things, and conflating them would either
 * leak or lie:
 *   restricted scope → the reader may not see it            → the placeholder, redacted
 *   unrestricted     → it is not in the org (deleted/bogus) → null, NOT redacted
 * The second is the pre-existing behaviour for a dangling link, and it is what keeps ADMIN - whose
 * scope fragment is empty for every type - reading exactly as it did before this change.
 */
export async function resolveEntityLabels(
  reader: EntityAccessReader,
  refs: EntityRef[],
  opts: { ability?: AppAbility } = {},
): Promise<Map<string, EntityLabel>> {
  const out = new Map<string, EntityLabel>();
  const byType = groupRefs(refs);
  if (!byType.size) return out;

  await Promise.all(
    [...byType.entries()].map(async ([type, ids]) => {
      const scope = await entityAccessScope(reader, type, opts);
      // Fail closed: an unknown type, or CUSTOMER without the subject grant. No query, all hidden.
      if (!scope) {
        ids.forEach((id) => out.set(entityRefKey(type, id), hidden(type)));
        return;
      }
      const where = { id: { in: ids }, ...scope.where };

      if (type === 'JOB') {
        const rows = await prisma.job.findMany({ where, select: { id: true, job_number: true, job_type: true } });
        rows.forEach((j) => out.set(entityRefKey('JOB', j.id), visible(j.job_type ? `${j.job_number} · ${j.job_type}` : j.job_number)));
      } else if (type === 'LEAD') {
        const rows = await prisma.lead.findMany({ where, select: { id: true, lead_number: true, job_type: true } });
        rows.forEach((l) => out.set(entityRefKey('LEAD', l.id), visible(l.job_type ? `${l.lead_number} · ${l.job_type}` : l.lead_number)));
      } else if (type === 'ESTIMATE') {
        const rows = await prisma.estimate.findMany({ where, select: { id: true, estimate_number: true } });
        rows.forEach((e) => out.set(entityRefKey('ESTIMATE', e.id), visible(e.estimate_number)));
      } else if (type === 'CUSTOMER') {
        const rows = await prisma.customer.findMany({ where, select: { id: true, company_name: true, first_name: true, last_name: true, customer_number: true } });
        rows.forEach((c) => out.set(entityRefKey('CUSTOMER', c.id), visible(customerLabel(c))));
      }

      for (const id of ids) {
        const key = entityRefKey(type, id);
        if (!out.has(key)) out.set(key, scope.restricted ? hidden(type) : visible(null));
      }
    }),
  );

  return out;
}

/**
 * The two wire fields a task carries for its link, read off a `resolveEntityLabels` map. One
 * helper so the list and the detail read cannot disagree about the redacted case.
 */
export function entityLabelFields(
  task: { linked_entity_type: string | null; linked_entity_id: string | null },
  labels: Map<string, EntityLabel>,
): { linked_entity_label: string | null; linked_entity_redacted: boolean } {
  if (!task.linked_entity_type || !task.linked_entity_id) {
    return { linked_entity_label: null, linked_entity_redacted: false };
  }
  const found = labels.get(entityRefKey(task.linked_entity_type, task.linked_entity_id));
  return {
    linked_entity_label: found?.label ?? null,
    linked_entity_redacted: found?.redacted ?? false,
  };
}

export async function resolveUserNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  const rows = await prisma.user.findMany({ where: { id: { in: unique }, organization_id: orgId }, select: { id: true, first_name: true, last_name: true } });
  rows.forEach((u) => out.set(u.id, userFullName(u)));
  return out;
}
