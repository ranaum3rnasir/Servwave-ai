import { Request } from 'express';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { customerLabel } from '../tasks/enrich';

export type ParticipantKind = 'USER' | 'CUSTOMER';

export interface ParticipantInput {
  kind: ParticipantKind;
  user_id?: string;
  customer_id?: string;
}

export interface ParticipantRow {
  id: string;
  kind: ParticipantKind;
  user_id: string | null;
  customer_id: string | null;
  notified_at: Date | null;
}

export interface EnrichedParticipant {
  id: string;
  kind: ParticipantKind;
  user_id: string | null;
  customer_id: string | null;
  notified_at: Date | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
  email: string | null;
}

/**
 * Org-validated FK guard (mirrors inv-stages.controller.ts's validateJobAndCustomer): before
 * persisting an inbound user_id/customer_id, confirm every referenced row actually belongs to
 * the requesting org. Returns an error message (→ 400) or null on success. Batches into at
 * most two queries regardless of how many participants were submitted.
 *
 * calendar_entry_participants carries no DB-level FK for user_id/customer_id (mirrors
 * notification_recipients.recipient_id) — this check is the only thing standing between a
 * cross-org id and a written participant row.
 */
export async function validateParticipantRefs(req: Request, participants: ParticipantInput[]): Promise<string | null> {
  const userIds = [...new Set(
    participants.filter((p) => p.kind === 'USER').map((p) => p.user_id).filter(Boolean) as string[],
  )];
  const customerIds = [...new Set(
    participants.filter((p) => p.kind === 'CUSTOMER').map((p) => p.customer_id).filter(Boolean) as string[],
  )];

  if (userIds.length) {
    const rows = await prisma.user.findMany({ where: { id: { in: userIds }, ...tenantWhere(req) }, select: { id: true } });
    if (rows.length !== userIds.length) return 'Invalid user_id in participants';
  }
  if (customerIds.length) {
    const rows = await prisma.customer.findMany({ where: { id: { in: customerIds }, ...tenantWhere(req) }, select: { id: true } });
    if (rows.length !== customerIds.length) return 'Invalid customer_id in participants';
  }
  return null;
}

/**
 * Batch-resolve each participant's display fields — user first/last name, customer name, and
 * the EMAIL of either kind — so list/detail responses need no per-row lookup later (slice-02
 * spec: "so later slices do not each re-resolve them").
 *
 * `email` is populated for USER rows as well as CUSTOMER rows (product-owner change,
 * 2026-08-25: "I actually wanted all participants to be notified"). Both kinds now flow
 * through the same three senders in lib/calendar-entries/notify.ts, so both need an address
 * resolved here rather than a second lookup bolted onto the notify path. `name` stays
 * CUSTOMER-only: a user's display name is assembled from first_name/last_name by every
 * existing reader, and filling `name` for them too would give those readers two sources for
 * one label.
 */
export async function resolveParticipantDisplay(orgId: string, rows: ParticipantRow[]): Promise<EnrichedParticipant[]> {
  const userIds = [...new Set(
    rows.filter((r) => r.kind === 'USER' && r.user_id).map((r) => r.user_id as string),
  )];
  const customerIds = [...new Set(
    rows.filter((r) => r.kind === 'CUSTOMER' && r.customer_id).map((r) => r.customer_id as string),
  )];

  const [users, customers] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds }, organization_id: orgId }, select: { id: true, first_name: true, last_name: true, email: true } })
      : Promise.resolve([] as { id: string; first_name: string; last_name: string; email: string }[]),
    customerIds.length
      ? prisma.customer.findMany({ where: { id: { in: customerIds }, organization_id: orgId }, select: { id: true, company_name: true, first_name: true, last_name: true, customer_number: true, email: true } })
      : Promise.resolve([] as { id: string; company_name: string | null; first_name: string | null; last_name: string | null; customer_number: string; email: string | null }[]),
  ]);

  const userMap = new Map(users.map((u) => [u.id, u]));
  const customerMap = new Map(customers.map((c) => [c.id, c]));

  return rows.map((r) => {
    const u = r.kind === 'USER' && r.user_id ? userMap.get(r.user_id) : undefined;
    const c = r.kind === 'CUSTOMER' && r.customer_id ? customerMap.get(r.customer_id) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      user_id: r.user_id,
      customer_id: r.customer_id,
      notified_at: r.notified_at,
      first_name: u ? u.first_name : null,
      last_name: u ? u.last_name : null,
      name: c ? customerLabel(c) : null,
      email: u ? u.email : (c ? c.email : null),
    };
  });
}
