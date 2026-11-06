/* =============================================================================
   Shared fixture for the permission-switch suites that run against a real migrated database
   (TEST_DATABASE_URL). Not a test file: the suites that import it declare their own `vi.mock` of
   the app's prisma client (vitest hoists that per file) and hand the real client in here.

   An org built here has an admin, and `addUser` / `addCustomRole` add the people and roles a case
   needs. Every org is removed again by `cleanup`.
   ========================================================================== */

import request from 'supertest';
import { randomUUID } from 'crypto';
import { vi } from 'vitest';
import type { JobStatus, PrismaClient, Role } from '@prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearSwitchCacheForOrg, clearSwitchCacheForUser } from '../lib/permissions/switches/cache';
import type { SwitchValue } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { assertPossibleSwitchSet } from './support/switchDependants';
import { setFirstOwner } from '../lib/users/first-owner';

export type Person = { id: string; email: string };

export function switchFixture(db: PrismaClient, loadApp: () => Promise<Parameters<typeof request>[0]>) {
  const orgs: string[] = [];
  const adminOf = new Map<string, string>();
  let app: Parameters<typeof request>[0] | undefined;

  /** Sign in as this person for the next calls (the auth layer caches the resolved user by token). */
  async function signedInAs(person: Person) {
    app ??= await loadApp();
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: person.id, email: person.email } },
      error: null,
    });
    const bearer = `Bearer switches-${person.id}`;
    const server = app;
    return {
      get: (path: string) => request(server).get(path).set('Authorization', bearer),
      post: (path: string, body: object = {}) => request(server).post(path).set('Authorization', bearer).send(body),
      put: (path: string, body: object = {}) => request(server).put(path).set('Authorization', bearer).send(body),
      patch: (path: string, body: object = {}) => request(server).patch(path).set('Authorization', bearer).send(body),
      // A DELETE may carry a body (the deactivation names who gets the person's email).
      delete: (path: string, body?: object) => {
        const call = request(server).delete(path).set('Authorization', bearer);
        return body === undefined ? call : call.send(body);
      },
    };
  }

  /**
   * An org with an admin, a customer, and an invoice and an estimate on it that anyone with the grants can open. The admin is
   * the company's Owner, set the way onboarding sets it (AL-16).
   */
  async function newOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `switches-${tag}`, email: `switches-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        // Leads and the rest of the product sit behind the plan; these suites are about permissions.
        plan: 'SCALE',
      },
    });
    const admin: Person = { id: randomUUID(), email: `admin-${tag}@example.test` };
    await db.user.create({
      data: { id: admin.id, organization_id: org, email: admin.email, first_name: 'Test', last_name: 'Admin', role: 'ADMIN', is_admin: true },
    });
    await setFirstOwner(db, org, admin.id);
    adminOf.set(org, admin.id);
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    return { org, tag, admin, customer };
  }

  /** A person on a built-in role (and optionally a custom role of that base). */
  async function addUser(
    org: string,
    name: string,
    role: Role,
    opts: { customRoleId?: string; basedOnRoleKey?: string; departmentId?: string; locationId?: string; isAdmin?: boolean } = {},
  ): Promise<Person> {
    const person: Person = { id: randomUUID(), email: `${name}-${org.slice(0, 8)}@example.test` };
    await db.user.create({
      data: {
        id: person.id, organization_id: org, email: person.email, first_name: name, last_name: 'Tester', role,
        // Admin is the flag on the person (P15). A person added as the Administrator role, with no custom role, is an Admin.
        is_admin: opts.isAdmin ?? (role === 'ADMIN' && !opts.customRoleId),
        custom_role_id: opts.customRoleId ?? null,
        based_on_role_key: opts.basedOnRoleKey ?? null,
        department_id: opts.departmentId ?? null,
        location_id: opts.locationId ?? null,
      },
    });
    clearSwitchCacheForUser(person.id);
    return person;
  }

  /**
   * The person's own mailbox with a primary address, so a send by hand (an estimate, an invoice, the pickup ticket) has an
   * address to go out from; without one the route answers 409 "address needed" (PRD 10, S10.12).
   */
  async function addUserMailbox(org: string, person: Person) {
    const id = randomUUID();
    await db.mailbox.create({
      data: { id, organization_id: org, kind: 'user', user_id: person.id, holder_user_id: person.id, status: 'active' },
    });
    await db.mailboxAddress.create({
      data: { local_part: person.email.split('@')[0]!.toLowerCase(), organization_id: org, mailbox_id: id, is_primary: true },
    });
    return id;
  }

  /**
   * A custom role under its own key. It holds no stored switch values: a switch resolves from the preset of its base role
   * (or off, for a role `madeFromBlank`) until a test gives it values. `copyGrants` and `extraGrants` are accepted and
   * ignored: the old per-role grant rows are gone, and callers that pass them are left as they were.
   */
  async function addCustomRole(
    org: string,
    key: string,
    baseRole: Role,
    opts: { madeFromBlank?: boolean; copyGrants?: boolean; extraGrants?: { action: string; subject: string }[] } = {},
  ) {
    const row = await db.customRole.create({
      data: {
        organization_id: org, key, label: key, base_role: baseRole, made_from_blank: opts.madeFromBlank ?? false,
      },
    });
    clearPermissionCache(org);
    return row;
  }

  /**
   * Give a custom role exactly these switch values, in two statements. The writer the Roles screen uses
   * (setRoleSwitchValues) upserts a switch at a time and logs each change, a round trip per switch that a fixture with
   * 200 switches pays for every person it builds. The set still has to pass the catalog's validator, and is refused the same
   * way when it does not, so a fixture never holds a combination the product refuses. Pass every switch the case is
   * about (a switch with no stored row falls back to the preset of the role's base); a suite that tests the writer itself
   * calls setRoleSwitchValues. The role's whole set after the write (its preset and stored values with these laid over
   * them) must be one a person can hold too; `impossibleOnPurpose` (with its reason) lets a test store one on purpose.
   */
  async function setRoleSwitches(
    org: string,
    key: string,
    values: Record<string, SwitchValue>,
    options: { impossibleOnPurpose?: string } = {},
  ) {
    const violations = validateSwitchSet(values);
    if (violations.length && options.impossibleOnPurpose === undefined) {
      const { InvalidSwitchSetError } = await import('../lib/permissions/switches/store.js');
      throw new InvalidSwitchSetError(violations);
    }
    // The values alone can pass while the role's whole set does not: a root turned off here with a dependant left on by
    // the preset or an earlier call. Check what the role will hold, read the way the product reads it.
    const role = await db.customRole.findFirst({ where: { organization_id: org, key }, select: { base_role: true } });
    const { resolveRoleSwitchValues } = await import('../lib/permissions/switches/store.js');
    const held = await resolveRoleSwitchValues(org, key, role?.base_role ?? key);
    assertPossibleSwitchSet({ ...held, ...values }, `setRoleSwitches (${key})`, options);
    // Replace the stored rows of these switches (what an upsert each does), so a case can change a role it built before.
    const switchKeys = Object.keys(values);
    await db.permissionRoleSwitch.deleteMany({ where: { organization_id: org, role_key: key, switch_key: { in: switchKeys } } });
    await db.permissionRoleSwitch.createMany({
      data: switchKeys.map((switch_key) => ({ organization_id: org, role_key: key, switch_key, value: values[switch_key]! })),
    });
    clearSwitchCacheForOrg(org);
  }

  /** A draft estimate on the customer with one $100 line, optionally already carrying a discount. */
  async function addEstimate(
    org: string,
    customer: string,
    createdBy: string,
    opts: { discount?: { type: 'PERCENTAGE' | 'FIXED_AMOUNT'; value: number }; leadId?: string; jobId?: string } = {},
  ) {
    const id = randomUUID();
    await db.estimate.create({
      data: {
        id, organization_id: org, customer_id: customer, created_by: createdBy,
        lead_id: opts.leadId ?? null, job_id: opts.jobId ?? null,
        estimate_number: `E-${id.slice(0, 8)}`, subtotal: 100, tax_amount: 0, total_amount: 100,
        discount_type: opts.discount?.type ?? null, discount_value: opts.discount?.value ?? null,
      },
    });
    const line = await db.estimateLineItem.create({
      data: { estimate_id: id, sequence: 1, description: 'Service', quantity: 1, unit_price: 100, line_total: 100 },
    });
    return { id, lineId: line.id };
  }

  /**
   * A draft invoice on the customer with one $100 line. `jobId` puts it on a job; `estimateId` makes it the
   * estimate's deposit invoice when it has no job; `createdBy` is the person who made it (attaches nobody).
   */
  async function addInvoice(
    org: string,
    customer: string,
    opts: { jobId?: string; estimateId?: string; createdBy?: string; servicePlanId?: string } = {},
  ) {
    const id = randomUUID();
    await db.invoice.create({
      data: {
        id, organization_id: org, customer_id: customer, invoice_number: `INV-${id.slice(0, 8)}`,
        subtotal: 100, tax_amount: 0, total_amount: 100, amount_due: 100, status: 'DRAFT',
        job_id: opts.jobId ?? null, estimate_id: opts.estimateId ?? null, created_by_id: opts.createdBy ?? null,
        // A plan's own invoice (activation or renewal) belongs to the plan and to no job.
        kind: opts.servicePlanId ? 'PLAN' : 'STANDARD', service_plan_id: opts.servicePlanId ?? null,
      },
    });
    const line = await db.invoiceLineItem.create({
      data: { invoice_id: id, sequence: 1, description: 'Service', quantity: 1, unit_price: 100, line_total: 100 },
    });
    return { id, lineId: line.id };
  }


  /** A service plan for the customer, with the person who sold it (its "Sold by"). */
  async function addServicePlan(org: string, customer: string, opts: { soldBy?: string } = {}) {
    const id = randomUUID();
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    await db.servicePlan.create({
      data: {
        id, organization_id: org, customer_id: customer, service_location_id: location,
        service_plan_number: `SP-${id.slice(0, 8)}`, name: 'Quarterly checks', status: 'ACTIVE', visit_cadence: 'QUARTERLY',
        start_date: new Date(), contract_price: 300, sold_by: opts.soldBy ?? null,
      },
    });
    return { id, location };
  }

  async function addDepartment(org: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.department.create({ data: { id, organization_id: org, name: `${name}-${id.slice(0, 6)}` } });
    return id;
  }

  async function addLocation(org: string, name: string): Promise<string> {
    const id = randomUUID();
    await db.location.create({ data: { id, organization_id: org, name: `${name}-${id.slice(0, 6)}` } });
    return id;
  }

  /**
   * A lead on the customer. `assignees` are its assignee rows, `owner` its commission owner,
   * `walkthroughCrew` the crew of a walkthrough visit on it, and `createdBy` the person who made it
   * (which attaches nobody).
   */
  async function addLead(
    org: string,
    customer: string,
    opts: { assignees?: string[]; owner?: string; dispatcher?: string; walkthroughCrew?: string[]; createdBy?: string } = {},
  ) {
    const id = randomUUID();
    await db.lead.create({
      data: {
        id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        commission_owner_id: opts.owner ?? null, dispatcher_id: opts.dispatcher ?? null, created_by_id: opts.createdBy ?? null,
      },
    });
    for (const user of opts.assignees ?? []) {
      await db.leadAssignee.create({ data: { lead_id: id, user_id: user, organization_id: org } });
    }
    let walkthroughId: string | undefined;
    if (opts.walkthroughCrew) {
      walkthroughId = await addVisit(org, { leadId: id, purpose: 'WALKTHROUGH', crew: opts.walkthroughCrew, daysFromNow: 1 });
    }
    return { id, walkthroughId };
  }

  /** A visit on a job or a lead, with its crew. A negative `daysFromNow` is a visit in the past. */
  async function addVisit(
    org: string,
    opts: { jobId?: string; leadId?: string; purpose?: 'WORK' | 'WALKTHROUGH'; crew?: string[]; daysFromNow?: number; seq?: number },
  ) {
    const id = randomUUID();
    const days = opts.daysFromNow ?? 1;
    const start = new Date(Date.now() + days * 86_400_000);
    await db.visit.create({
      data: {
        id, organization_id: org, job_id: opts.jobId ?? null, lead_id: opts.leadId ?? null, purpose: opts.purpose ?? 'WORK',
        visit_seq: opts.seq ?? 1, status: days < 0 ? 'COMPLETED' : 'SCHEDULED', scheduled_at: start, scheduled_end: new Date(start.getTime() + 3_600_000),
      },
    });
    for (const user of opts.crew ?? []) {
      await db.visitAssignee.create({ data: { visit_id: id, user_id: user, organization_id: org } });
    }
    return id;
  }

  /**
   * A job on the customer. `crew` is put on one visit (in the past, or upcoming); `soldBy` is the job's
   * salesperson, `dispatcher` its dispatcher, `createdBy` the person who made it (attaches nobody) and
   * `fromLead` links it to a lead through an estimate, the way a converted lead is, and `sourcePlan` makes it
   * one of that service plan's booked visit jobs.
   */
  async function addJob(
    org: string,
    customer: string,
    opts: {
      crew?: string[]; pastVisit?: boolean; soldBy?: string; dispatcher?: string; createdBy?: string;
      fromLead?: string; sourcePlan?: string; status?: JobStatus;
    } = {},
  ) {
    const id = randomUUID();
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    let estimateId: string | undefined;
    if (opts.fromLead) {
      estimateId = randomUUID();
      await db.estimate.create({
        data: {
          id: estimateId, organization_id: org, customer_id: customer, lead_id: opts.fromLead, created_by: adminOf.get(org)!,
          estimate_number: `E-${estimateId.slice(0, 8)}`, subtotal: 100, tax_amount: 0, total_amount: 100,
        },
      });
    }
    await db.job.create({
      data: {
        id, organization_id: org, customer_id: customer, service_location_id: location, job_number: `J-${id.slice(0, 8)}`,
        status: opts.status ?? 'SCHEDULED', estimate_id: estimateId ?? null, lead_id: opts.fromLead ?? null,
        salesperson_id: opts.soldBy ?? null, source_plan_id: opts.sourcePlan ?? null, dispatcher_id: opts.dispatcher ?? null, created_by_id: opts.createdBy ?? null,
      },
    });
    let visitId: string | undefined;
    if (opts.crew) visitId = await addVisit(org, { jobId: id, crew: opts.crew, daysFromNow: opts.pastVisit ? -2 : 2 });
    return { id, visitId, estimateId };
  }

  /** Take a person off a job's visits, or off a lead's assignees, the way the office does. */
  async function removeCrew(visitId: string, user: string) {
    await db.visitAssignee.deleteMany({ where: { visit_id: visitId, user_id: user } });
  }

  async function cleanup() {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    // Every org at once: a statement per org per table is thousands of round trips for a suite that builds an org per case,
    // and this hook has the suite's hook time limit to finish in. The order of the tables is what the foreign keys need.
    const inOrgs = orgs.map((org) => `'${org}'`).join(', ');
    if (orgs.length) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id IN (${inOrgs}))`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN (${inOrgs}))`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN (${inOrgs}))`));
      for (const table of [
        'permission_change_log', 'permission_user_switches', 'permission_role_switches',
        // Notes hold their author (and editor) by a foreign key: they go before the people.
        'notes', 'timeline_events', 'notifications', 'invoices', 'jobs',
        'service_plans',
        'estimates', 'leads',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id IN (${inOrgs})`));
      }
      // audit_logs is not cleared: the database refuses any delete there (M14, ticket 25), and its rows hold no foreign key.
      for (const table of ['mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id IN (${inOrgs})`));
      }
      // The Owner's row can't be deleted while they are the Owner (AL-16): the company lets go of them first.
      await quietly(db.$executeRawUnsafe(`UPDATE organizations SET owner_user_id = NULL WHERE id IN (${inOrgs})`));
      for (const table of ['customers', 'users', 'custom_roles', 'departments', 'locations']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id IN (${inOrgs})`));
      }
      await quietly(db.organization.deleteMany({ where: { id: { in: orgs } } }));
    }
    await db.$disconnect();
  }

  return {
    signedInAs, newOrg, addUser, addUserMailbox, addCustomRole, setRoleSwitches, addEstimate, addInvoice, addServicePlan,
    addDepartment, addLocation, addLead, addVisit, addJob, removeCrew, cleanup,
  };
}
