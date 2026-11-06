/* =============================================================================
   Test helper (not a test file): a company that passes the Spider gate, with Spider switched on, people Spider tells
   and New leads past their limit. The Spider suites that need a big or a plain company (#3107, and #3108 after it)
   build theirs here.

   The company comes to exist the way a real one does, each thing after what it depends on:
     1. the organization (and its phone number), long before anything else;
     2. its people, an hour after, and its customer;
     3. its leads, each created a minute before the one after it, a day or more before the sweep that finds them;
     4. Spider switched on - by the same values the switch route writes (spider.controller.ts setSpiderActive):
        `activated_at`, `summary_trigger_at` and `summary_trigger_since` all the one instant, kind SWITCHED_ON.
   With `trigger: true` the switch-on comes LAST, an hour before the sweep: the leads are a backlog and the first sweep
   builds a starting summary. With `trigger: false` Spider was switched on BEFORE the first lead existed and its trigger
   has long been acted on (nothing was overdue then), so the first sweep alerts the leads one by one.
   Every person can sign in and has an email and a phone. Pass the REAL client the suite wires `lib/prisma` to.
   ========================================================================== */

import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The clock the suites run the sweep at. */
export const T0 = new Date('2026-10-01T12:00:00.000Z');
export const at = (ms: number) => new Date(T0.getTime() + ms);

let personSeq = 0;
export const tag = randomUUID().slice(0, 8);

export const MIN = 60_000;

export interface SpiderCompany {
  org: string;
  customer: string;
  people: { id: string; email: string; role: Role }[];
  leads: string[];
  /** When Spider was switched on (the instant the switch route would have written). */
  switchedOnAt: Date;
}

/** When lead number `i` of a company of `n` was created: i minutes before the previous, the newest two days before the sweep. */
const leadCreatedAt = (i: number) => at(-2 * DAY - i * MIN);

/**
 * A lead on the company's customer, in New since `createdAt` (which must be after the customer and the organization
 * existed; the helper's own leads are two days or more before T0).
 */
export async function addLead(db: PrismaClient, c: Pick<SpiderCompany, 'org' | 'customer'>, createdAt: Date): Promise<string> {
  const id = randomUUID();
  await db.lead.create({
    data: {
      id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 12)}`, service_request: 'Fix the door',
      status: 'NEW', created_at: createdAt,
    },
  });
  return id;
}

/**
 * A company with `admins` Admins and `dispatchers` Dispatchers (Spider tells all of them), `leads` New leads (against a
 * 2-hour limit), and every channel on. See the header for the order things are made in and for `trigger`.
 */
export async function spiderCompany(
  db: PrismaClient,
  orgs: string[],
  opts: { leads: number; admins?: number; dispatchers?: number; trigger?: boolean },
): Promise<SpiderCompany> {
  const org = randomUUID();
  orgs.push(org);
  const short = org.slice(0, 8);
  const oldestLead = leadCreatedAt(Math.max(opts.leads, 1) - 1);
  const customerAt = new Date(oldestLead.getTime() - DAY);
  const orgAt = new Date(customerAt.getTime() - 30 * DAY);
  const peopleAt = new Date(orgAt.getTime() + HOUR);

  await db.organization.create({
    data: {
      id: org, name: `spider-sets-${short}`, email: `org-${short}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      plan: 'SCALE', is_demo: true, feature_overrides: {} as never, email_sending_enabled: true,
      ctm_account_id: `acct-${short}`, ctm_sms_ready: true, sms_sending_enabled: true,
      created_at: orgAt,
    },
  });
  await db.phoneNumber.create({
    data: { organization_id: org, e164: '+16175550000', sms_enabled: true, ctm_number_id: `TPN-${short}`, status: 'active', is_org_default: true, created_at: orgAt },
  });
  const roles: Role[] = [
    ...Array.from({ length: opts.admins ?? 2 }, () => 'ADMIN' as Role),
    ...Array.from({ length: opts.dispatchers ?? 1 }, () => 'DISPATCHER' as Role),
  ];
  const people = roles.map((role) => {
    personSeq += 1;
    return { id: randomUUID(), email: `p${personSeq}-${tag}@example.test`, role, phone: `+1617${String(5_000_000 + personSeq).slice(-7)}` };
  });
  await db.user.createMany({
    data: people.map((p, i) => ({
      id: p.id, organization_id: org, email: p.email, first_name: `${p.role.toLowerCase()}${i}`, last_name: 'Tester', role: p.role,
      is_admin: p.role === 'ADMIN', phone: p.phone, is_active: true, has_login: true, created_at: peopleAt,
    })),
  });
  const customer = randomUUID();
  await db.customer.create({
    data: {
      id: customer, organization_id: org, customer_number: `C-${short}`, kind: 'PERSON', segment: 'RESIDENTIAL',
      first_name: 'Pat', last_name: 'Payer', phone: '+16175559999', created_at: customerAt,
    },
  });

  // What the switch route writes (spider.controller.ts setSpiderActive): all three at the one instant.
  const switchOn = (instant: Date, withTrigger: boolean) => {
    const off = { enabled: false, value: 1, unit: 'DAY' };
    return db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: instant,
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' }, CONTACTED: off, WALKTHROUGH_COMPLETED: off },
        channels: { in_app: true, red_frame: true, email: true, text: true },
        recipients: { roles: ['ADMIN', 'DISPATCHER'], user_ids: [], lead_owner: false },
        watch_all_leads: true, selected_lead_ids: [],
        summary_trigger_at: withTrigger ? instant : null,
        summary_trigger_since: withTrigger ? instant : null,
        summary_trigger_kind: withTrigger ? 'SWITCHED_ON' : null,
      },
    });
  };

  // Spider already on, its trigger acted on with nothing overdue, before any lead existed.
  const switchedOnAt = opts.trigger ? at(-HOUR) : new Date(customerAt.getTime() + HOUR);
  if (!opts.trigger) await switchOn(switchedOnAt, false);
  const leads = Array.from({ length: opts.leads }, () => randomUUID());
  await db.lead.createMany({
    data: leads.map((id, i) => ({
      id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 12)}`, service_request: 'Fix the door',
      status: 'NEW' as const, created_at: leadCreatedAt(i),
    })),
  });
  // Switched on over the backlog: the leads are already past their limit.
  if (opts.trigger) await switchOn(switchedOnAt, true);
  return { org, customer, people: people.map(({ id, email, role }) => ({ id, email, role })), leads, switchedOnAt };
}

/** Removes the companies a suite built: everything they hold, then the companies. */
export async function removeCompanies(db: PrismaClient, orgs: string[]) {
  const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
  for (const org of orgs) {
    await quietly(db.notification.deleteMany({ where: { organization_id: org } }));
    for (const table of ['spider_alerts', 'spider_summaries', 'spider_recipient_sets', 'spider_settings', 'leads', 'phone_numbers', 'customers', 'users']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = $1::uuid`, org));
    }
    await quietly(db.organization.deleteMany({ where: { id: org } }));
  }
}
