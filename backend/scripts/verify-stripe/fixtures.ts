import { randomUUID } from 'crypto';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';

export interface Fixtures {
  orgId: string;
  userId: string;
  customerId: string;
  serviceLocationId: string;
  leadId: string;
  estimateId: string;
  depositId: string;
  depositAmount: number;
  jobId: string;
  invoiceId: string;
  prefix: string;
  // Synthetic Stripe PI IDs for signed webhook events — same values referenced by flow-E
  depositPiId: string;
  invoicePiId: string;
  startedAt: Date;
}

export async function setupFixtures(): Promise<Fixtures> {
  const ts = Date.now();
  const prefix = `9C-VERIFY-${ts}`;
  const startedAt = new Date();

  const orgId = randomUUID();
  const org = await prisma.organization.create({
    data: {
      id: orgId,
      plan: 'SCALE',
      name: `${prefix}-Org`,
      address_line1: '1 Harness St',
      city: 'Testville',
      state: 'CA',
      postal_code: '90001',
      email: `${prefix}-org@test.invalid`,
      estimate_terms: 'Verification test terms',
      estimate_notes: 'Verification test notes',
      estimate_payment_terms: '50% on acceptance',
    },
  });
  // The starter task categories every new org gets. Removed with the org (ON DELETE CASCADE).
  await seedStarterTaskCategories(prisma, org.id);

  const user = await prisma.user.create({
    data: {
      organization_id: org.id,
      email: `${prefix}-user@test.invalid`,
      first_name: 'Verify',
      last_name: 'User',
      role: 'ADMIN',
    },
  });

  const customer = await prisma.customer.create({
    data: {
      organization_id: org.id,
      first_name: 'Verify',
      last_name: 'Customer',
      email: `${prefix}-cust@test.invalid`,
      phone: '555-0000',
      // Creator tracking (audit only): a verification fixture, minted by the script.
      created_by_source: 'SYSTEM',
    },
  });

  const serviceLocation = await prisma.serviceLocation.create({
    data: {
      customer_id: customer.id,
      address_line1: '1 Harness St',
      city: 'Testville',
      state: 'CA',
      zip: '90001',
    },
  });

  const lead = await prisma.lead.create({
    data: {
      organization_id: org.id,
      customer_id: customer.id,
      lead_number: `L-VER-${ts}`,
      service_request: 'Verification test service request',
      // Creator tracking (audit only): a verification fixture, minted by the script.
      created_by_source: 'SYSTEM',
    },
  });

  const estimate = await prisma.estimate.create({
    data: {
      organization_id: org.id,
      lead_id: lead.id,
      estimate_number: `E-VER-${ts}`,
      created_by: user.id,
      status: 'APPROVED',
      subtotal: 500.00,
      tax_amount: 43.75,
      total_amount: 543.75,
    },
  });

  const depositAmount = 500.00;
  const deposit = await prisma.deposit.create({
    data: {
      estimate_id: estimate.id,
      amount: depositAmount,
      deposit_percentage: 50,
      status: 'REQUESTED',
      surcharge_amount: 0,
    },
  });

  const job = await prisma.job.create({
    data: {
      organization_id: org.id,
      customer_id: customer.id,
      service_location_id: serviceLocation.id,
      estimate_id: estimate.id,
      job_number: `J-VER-${ts}`,
      status: 'COMPLETED',
      // Creator tracking (audit only): a verification fixture, minted by the script.
      created_by_source: 'SYSTEM',
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      organization_id: org.id,
      job_id: job.id,
      invoice_number: `I-VER-${ts}`,
      status: 'SENT',
      subtotal: 500.00,
      tax_amount: 43.75,
      deposit_credit: 0,
      total_amount: 543.75,
      amount_due: 543.75,
      // Creator tracking (audit only): a verification fixture, minted by the script.
      created_by_source: 'SYSTEM',
    },
  });

  return {
    orgId: org.id,
    userId: user.id,
    customerId: customer.id,
    serviceLocationId: serviceLocation.id,
    leadId: lead.id,
    estimateId: estimate.id,
    depositId: deposit.id,
    depositAmount,
    jobId: job.id,
    invoiceId: invoice.id,
    prefix,
    depositPiId: `pi_ver_dep_${ts}`,
    invoicePiId: `pi_ver_inv_${ts}`,
    startedAt,
  };
}

export async function teardownFixtures(f: Fixtures): Promise<void> {
  const entityIds = [f.depositId, f.estimateId, f.leadId, f.jobId, f.invoiceId];

  // Delete in dependency order (no cascade from org → children in schema)
  await prisma.timelineEvent.deleteMany({ where: { entity_id: { in: entityIds } } });
  await prisma.payment.deleteMany({ where: { invoice_id: f.invoiceId } });
  await prisma.invoice.deleteMany({ where: { id: f.invoiceId } });
  await prisma.job.deleteMany({ where: { id: f.jobId } });
  await prisma.deposit.deleteMany({ where: { estimate_id: f.estimateId } });
  await prisma.estimate.deleteMany({ where: { id: f.estimateId } });
  await prisma.lead.deleteMany({ where: { id: f.leadId } });
  // ServiceLocations cascade from Customer; delete User before Customer due to no cascade
  await prisma.user.deleteMany({ where: { id: f.userId } });
  // Customer deletes cascade ServiceLocation
  await prisma.customer.deleteMany({ where: { id: f.customerId } });
  await prisma.organization.deleteMany({ where: { id: f.orgId } });
  // Best-effort StripeEvent cleanup (no FK to org; clean up by time window)
  await prisma.stripeEvent.deleteMany({ where: { created_at: { gte: f.startedAt } } });
}
