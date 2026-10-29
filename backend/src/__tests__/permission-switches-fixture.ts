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
import type { PrismaClient, Role } from '@prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

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
      delete: (path: string) => request(server).delete(path).set('Authorization', bearer),
    };
  }

  /** An org with an admin, a customer, and an invoice and an estimate on it that anyone with the grants can open. */
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
      data: { id: admin.id, organization_id: org, email: admin.email, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
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
    opts: { customRoleId?: string; basedOnRoleKey?: string; departmentId?: string; locationId?: string } = {},
  ): Promise<Person> {
    const person: Person = { id: randomUUID(), email: `${name}-${org.slice(0, 8)}@example.test` };
    await db.user.create({
      data: {
        id: person.id, organization_id: org, email: person.email, first_name: name, last_name: 'Tester', role,
        custom_role_id: opts.customRoleId ?? null,
        department_id: opts.departmentId ?? null,
        location_id: opts.locationId ?? null,
      },
    });
    clearUserOverrideCache(person.id);
    return person;
  }

  /**
   * A custom role with the grants of a built-in role under its own key, the way creating a role in
   * the Roles screen copies them. `madeFromBlank` marks a role started from nothing.
   */
  async function addCustomRole(
    org: string,
    key: string,
    baseRole: Role,
    opts: { madeFromBlank?: boolean; copyGrants?: boolean; extraGrants?: { action: string; subject: string }[] } = {},
  ) {
    const row = await db.customRole.create({
      data: {
        organization_id: org, key, label: key, base_role: baseRole,
      },
    });
    if (opts.copyGrants !== false) {
      for (const g of DEFAULT_GRANTS.filter((x) => x.role === baseRole)) {
        await db.rolePermission.create({
          data: {
            organization_id: org, role: key, action: g.action, subject: g.subject,
            conditions: (g.conditions ?? undefined) as never,
          },
        });
      }
    }
    for (const g of opts.extraGrants ?? []) {
      await db.rolePermission.create({ data: { organization_id: org, role: key, action: g.action, subject: g.subject } });
    }
    clearPermissionCache(org);
    return row;
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
        commission_owner_id: opts.owner ?? null, created_by_id: opts.createdBy ?? null,
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
      fromLead?: string; sourcePlan?: string; status?: 'UNSCHEDULED' | 'SCHEDULED' | 'IN_PROGRESS';
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
        salesperson_id: opts.soldBy ?? null, source_plan_id: opts.sourcePlan ?? null, created_by_id: opts.createdBy ?? null,
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
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_line_items WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of [
        'permission_change_log', 'permission_user_switches', 'permission_role_switches',
        'user_permission_overrides', 'role_permissions',
        'timeline_events', 'notifications', 'invoices', 'jobs',
        'service_plans',
        'estimates', 'leads',
      ]) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users', 'custom_roles', 'departments', 'locations']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  }

  return {
    signedInAs, newOrg, addUser, addCustomRole, addEstimate, addInvoice, addServicePlan,
    addDepartment, addLocation, addLead, addVisit, addJob, removeCrew, cleanup,
  };
}
