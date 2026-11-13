/**
 * Whether a person is still one of Spider's alert recipients (#3462): the per-person half of "an open alert follows the
 * current Spider settings" (#3450). `alertStillOpen` (sweep.ts) decides per alert; this decides per person.
 *
 * Ran, 12 Nov: adding people never takes an open alert away; only the removal of the role, the named person or "lead
 * owner" that alerted someone ends theirs, and only when nothing left still covers them for that lead, the Admins
 * fallback included (recipients.ts, #2619). A lead reassigned ends its old owner's alert (unless a role or name covers
 * them). So there are two questions, kept apart:
 *
 *  - `entryCovers`: does a chosen ENTRY (role, name, or the lead's owner while "lead owner" is on) name the person? Pure,
 *    from rows already read; the unread read and the ending both use it.
 *  - the fallback: an Admin the entries do not name may still be alerted because the chosen people cannot be reached for
 *    that lead. That is recipients.ts's own per-lead rule (sign-in AND the bell's lead access), so the ending asks
 *    resolveSpiderRecipientsForLeads itself, batched per page, never a second copy of the rule.
 *
 * The alert's own stored list says why each person was told (`type`: owner | user | admin, spider_recipient_sets, #3107):
 * 'owner' is exact, 'admin' mixes "chosen by a role" with the fallback. So an Admin alerted as the lead's owner loses the card
 * once they no longer own the lead (unless an entry names them or the fallback alerts them), in the read and the sweep. An
 * Admin alerted as 'admin' keeps the card in the read and the sweep: only the save that removed what chose them ends it
 * (a failed or raced ending is not repaired by a later sweep: nothing can tell the role from the fallback then).
 */
import { prisma } from '../../lib/prisma';
import type { SpiderRecipients } from './config';
import { resolveSpiderRecipientsForLeads } from './recipients';

/** What the rule reads about a person. */
export interface CoverageReader {
  id: string;
  role: string;
  is_admin: boolean;
}

/** Whether a chosen entry names this person for a lead owned by `ownerId`. */
export function entryCovers(recipients: SpiderRecipients, reader: CoverageReader, ownerId: string | null | undefined): boolean {
  return (
    recipients.roles.some((r) => r === reader.role) ||
    recipients.user_ids.includes(reader.id) ||
    (recipients.lead_owner && !!ownerId && ownerId === reader.id)
  );
}

/** The unread read: a card stays unless the person is not an Admin and no entry names them (a reassigned lead's old owner, a role changed away). */
export function readerKeepsCard(recipients: SpiderRecipients, reader: CoverageReader, ownerId: string | null | undefined): boolean {
  return reader.is_admin || entryCovers(recipients, reader, ownerId);
}

/**
 * Whether saving `after` over `before` removes an entry: a role or a named person taken out, or "lead owner" switched off.
 * Adding people, or only changing channels or limits, removes nobody, so the ending is skipped.
 */
export function recipientsNarrowed(before: SpiderRecipients, after: SpiderRecipients): boolean {
  const roles = new Set<string>(after.roles);
  const ids = new Set(after.user_ids);
  return (
    before.roles.some((r) => !roles.has(r)) ||
    before.user_ids.some((id) => !ids.has(id)) ||
    (before.lead_owner && !after.lead_owner)
  );
}

/**
 * The unread read's Admin check (Ran's ruling 3): of an Admin reader's rows, those alerted as the lead's owner (stored type)
 * when they no longer own the lead, no entry names them and recipients.ts would not alert them for that lead now. One read of
 * the stored types for the rows no entry names, one recipients.ts call for the leads that remain; nothing for a reader an entry
 * names (the default, ADMIN chosen) or whose rows all still own their lead. Returns the recipient-row ids to hide.
 */
export async function ownerRowsAdminNoLongerHolds(args: {
  orgId: string;
  reader: CoverageReader;
  recipients: SpiderRecipients;
  rows: readonly { id: string; leadId: string; alertId: string | null }[];
  ownerOf: (leadId: string) => string | null | undefined;
}): Promise<Set<string>> {
  const { orgId, reader, recipients, rows, ownerOf } = args;
  const hide = new Set<string>();
  if (!reader.is_admin) return hide;
  const open = rows.filter((r) => r.alertId && !entryCovers(recipients, reader, ownerOf(r.leadId)));
  if (open.length === 0) return hide;
  const found = await prisma.$queryRaw<{ alert_id: string; type: string | null }[]>`
    SELECT a.id::text AS alert_id, st.type
    FROM spider_alerts a
    LEFT JOIN spider_recipient_sets s ON s.id = a.recipient_set_id
    LEFT JOIN LATERAL (
      SELECT p->>'type' AS type FROM jsonb_array_elements(coalesce(s.recipients, a.recipients, '[]'::jsonb)) p
      WHERE p->>'id' = ${reader.id} LIMIT 1
    ) st ON true
    WHERE a.organization_id = ${orgId}::uuid AND a.id = ANY(${open.map((r) => r.alertId!)}::uuid[])`;
  const ownerAlerts = new Set(found.filter((f) => f.type === 'owner').map((f) => f.alert_id));
  const owned = open.filter((r) => ownerAlerts.has(r.alertId!));
  if (owned.length === 0) return hide;
  const leads = [...new Set(owned.map((r) => r.leadId))].map((id) => ({ id, ownerId: ownerOf(id) ?? null }));
  const alerted = new Map<string, Set<string>>();
  for (let i = 0; i < leads.length; i += 500) {
    const byLead = await resolveSpiderRecipientsForLeads(prisma, { orgId, leads: leads.slice(i, i + 500), recipients });
    for (const [leadId, people] of byLead) alerted.set(leadId, new Set(people.map((p) => p.id)));
  }
  for (const r of owned) if (!alerted.get(r.leadId)?.has(reader.id)) hide.add(r.id);
  return hide;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How each alert's stored list says each of these people was chosen (`owner` | `user` | `admin`), for a page of rows: ONE
 * read, `WHERE organization_id = $org AND id = ANY($ids)` so it is an index read on the alert's primary key (under the
 * production role a join on an expression of the notification's JSON cannot use it: the functions are not leakproof and the
 * table is row-secured). Key `"alertId|personId"`; a missing key is an older row that cannot say (treated as 'admin').
 */
export async function storedChosenAs(
  orgId: string,
  rows: readonly { alertId: string | null; personId: string }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(rows.flatMap((r) => (r.alertId && UUID_TEXT.test(r.alertId) ? [r.alertId] : [])))];
  if (ids.length === 0) return out;
  const persons = [...new Set(rows.map((r) => r.personId))];
  const found = await prisma.$queryRaw<{ alert_id: string; person_id: string; type: string | null }[]>`
    SELECT a.id::text AS alert_id, p->>'id' AS person_id, p->>'type' AS type
    FROM spider_alerts a
    LEFT JOIN spider_recipient_sets s ON s.id = a.recipient_set_id
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.recipients, a.recipients, '[]'::jsonb)) p
    WHERE a.organization_id = ${orgId}::uuid AND a.id = ANY(${ids}::uuid[]) AND p->>'id' = ANY(${persons}::text[])`;
  for (const f of found) if (f.type) out.set(`${f.alert_id}|${f.person_id}`, f.type);
  return out;
}
