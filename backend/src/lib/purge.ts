import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * Entity-redesign §10 — force-purge cascade.
 *
 * App-level, top-down transactional cascade for hard-deleting a Customer (or a
 * single Lead) and the full subtree it anchors. The DB `onDelete` is NOT yet
 * `Restrict` (that swap is Phase D), so deletion ORDER matters here: every child
 * class must be deleted before its parent or a real Postgres FK constraint would
 * fire. The mock test suite cannot catch ordering bugs, so the order below is
 * curated against the live schema FK graph.
 *
 * Tenant-scope: every query is scoped to `orgId` via `organization_id` where the
 * model has it; org-less leaves (CustomerPhone / CustomerEmail / ServiceLocation /
 * Message / WhatsAppMessage / line items reached by parent id) are reached only
 * through ids already resolved under the tenant-scoped parent.
 *
 * DEFER (Phase D): once `onDelete: Restrict` + partial-unique indexes land, the
 * `bill_to_customer_id` SetNull on `billed_customers` becomes a hard edge — add an
 * explicit detach step then. Today it SetNulls at the DB, so no step is needed.
 */

type Tx = Prisma.TransactionClient;

const ID_IN = (ids: string[]) => ({ in: ids });

// ─── Money gate ─────────────────────────────────────────

function paymentSubtreeWhere(customerId: string, orgId: string) {
  return {
    invoice: {
      organization_id: orgId,
      OR: [
        { customer_id: customerId },
        { job: { customer_id: customerId } },
        // R6 (2026-07-22) — Estimate.customer_id is a direct column again; no lead hop needed.
        { estimate: { customer_id: customerId } },
      ],
    },
  };
}

/** Does ANY payment exist anywhere in the customer subtree (job/estimate/orphan anchors)? */
export async function hasPaymentInSubtree(customerId: string, orgId: string): Promise<boolean> {
  const count = await prisma.payment.count({ where: paymentSubtreeWhere(customerId, orgId) });
  return count > 0;
}

export interface PaymentSummary {
  hasPayment: boolean;
  paymentTotal: number;
  hasStripeCharge: boolean;
}

/** Summarize payments in the subtree for the force-purge warning. */
export async function paymentSummaryForSubtree(customerId: string, orgId: string): Promise<PaymentSummary> {
  const payments = await prisma.payment.findMany({
    where: paymentSubtreeWhere(customerId, orgId),
    select: { amount: true, stripe_payment_intent_id: true },
  });
  const paymentTotal = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const hasStripeCharge = payments.some((p) => !!p.stripe_payment_intent_id);
  return { hasPayment: payments.length > 0, paymentTotal, hasStripeCharge };
}

// ─── Shared spine purge (used by both customer + lead purges) ───
//
// Given the resolved id-sets of a subtree, delete every comms/inventory/tag/
// polymorphic child and the financial spine in FK-safe order. Does NOT delete
// the customer leaves or the customer root — callers add those.

interface SubtreeIds {
  leadIds: string[];
  estimateIds: string[];
  jobIds: string[];
  invoiceIds: string[];
}

async function purgeSubtreeChildren(tx: Tx, orgId: string, ids: SubtreeIds): Promise<void> {
  const { leadIds, estimateIds, jobIds, invoiceIds } = ids;

  // STEP 1 — Comms (nullable FKs into Customer/Lead/Job). Children before parents.
  if (leadIds.length) {
    const threads = await tx.messageThread.findMany({
      where: { organization_id: orgId, lead_id: ID_IN(leadIds) },
      select: { id: true },
    });
    const threadIds = threads.map((t) => t.id);
    if (threadIds.length) await tx.message.deleteMany({ where: { organization_id: orgId, thread_id: ID_IN(threadIds) } });
    await tx.messageThread.deleteMany({ where: { organization_id: orgId, lead_id: ID_IN(leadIds) } });

    const chats = await tx.whatsAppChat.findMany({
      where: { organization_id: orgId, lead_id: ID_IN(leadIds) },
      select: { id: true },
    });
    const chatIds = chats.map((c) => c.id);
    if (chatIds.length) await tx.whatsAppMessage.deleteMany({ where: { organization_id: orgId, chat_id: ID_IN(chatIds) } });
    await tx.whatsAppChat.deleteMany({ where: { organization_id: orgId, lead_id: ID_IN(leadIds) } });

    await tx.email.deleteMany({ where: { organization_id: orgId, lead_id: ID_IN(leadIds) } });
  }

  if (jobIds.length || leadIds.length) {
    await tx.callSession.deleteMany({
      where: { organization_id: orgId, OR: [{ job_id: ID_IN(jobIds) }, { lead_id: ID_IN(leadIds) }] },
    });

    // Manual communication log entries hang off exactly one of a lead or a job - the same two
    // anchors the call delete above uses. Their FKs DO cascade, so the rows would go when the
    // parent lead/job is deleted further down; deleting them explicitly here follows the same
    // children-before-parents discipline as every other line in this step, and it is what keeps
    // them out of purge-tenant-coverage's gap list (that guard only credits REQUIRED cascade
    // edges, and both of these anchors are nullable by design).
    await tx.manualCommunicationLog.deleteMany({
      where: { organization_id: orgId, OR: [{ job_id: ID_IN(jobIds) }, { lead_id: ID_IN(leadIds) }] },
    });
  }

  // STEP 2 — Inventory/procurement (nullable FKs into Estimate/Job). Children before parents.
  if (estimateIds.length || jobIds.length) {
    await tx.reservationLine.deleteMany({
      where: { organization_id: orgId, estimate_reservation: { OR: [{ estimate_id: ID_IN(estimateIds) }, { job_id: ID_IN(jobIds) }] } },
    });
    await tx.estimateReservation.deleteMany({
      where: { organization_id: orgId, OR: [{ estimate_id: ID_IN(estimateIds) }, { job_id: ID_IN(jobIds) }] },
    });
  }

  if (jobIds.length) {
    await tx.rfqLine.deleteMany({ where: { organization_id: orgId, rfq: { job_id: ID_IN(jobIds) } } });
    await tx.rfqQuote.deleteMany({ where: { organization_id: orgId, rfq: { job_id: ID_IN(jobIds) } } });
    await tx.rfq.deleteMany({ where: { organization_id: orgId, job_id: ID_IN(jobIds) } });

    // PurchaseOrder.staged_as_job_stage_id FKs JobStage → delete PO BEFORE JobStage.
    await tx.purchaseOrderLine.deleteMany({ where: { organization_id: orgId, purchase_order: { job_id: ID_IN(jobIds) } } });
    await tx.purchaseOrder.deleteMany({ where: { organization_id: orgId, job_id: ID_IN(jobIds) } });

    await tx.jobStageLine.deleteMany({ where: { organization_id: orgId, job_stage: { job_id: ID_IN(jobIds) } } });
    await tx.jobStageAttachment.deleteMany({ where: { organization_id: orgId, job_stage: { job_id: ID_IN(jobIds) } } });
    await tx.stageAuditEntry.deleteMany({ where: { organization_id: orgId, job_stage: { job_id: ID_IN(jobIds) } } });
    await tx.jobStage.deleteMany({ where: { organization_id: orgId, job_id: ID_IN(jobIds) } });

    await tx.stockApprovalModification.deleteMany({ where: { organization_id: orgId, stock_approval: { job_id: ID_IN(jobIds) } } });
    await tx.stockApproval.deleteMany({ where: { organization_id: orgId, job_id: ID_IN(jobIds) } });
  }

  // STEP 3 — Tags (polymorphic + lead tags). Contact/ChannelIdentity are customer-anchored
  // and handled by the customer-level caller; here we clear lead/estimate/job/invoice tags.
  if (leadIds.length) {
    await tx.leadTag.deleteMany({ where: { lead_id: ID_IN(leadIds) } });
  }
  if (leadIds.length || estimateIds.length || jobIds.length || invoiceIds.length) {
    await tx.tagAssignment.deleteMany({
      where: {
        organization_id: orgId,
        OR: [
          { entity_type: 'LEAD', entity_id: ID_IN(leadIds) },
          { entity_type: 'ESTIMATE', entity_id: ID_IN(estimateIds) },
          { entity_type: 'JOB', entity_id: ID_IN(jobIds) },
          { entity_type: 'INVOICE', entity_id: ID_IN(invoiceIds) },
        ],
      },
    });

    // STEP 4 — Polymorphic Attachment/Note/TimelineEvent for lead/estimate/job/invoice.
    const polyWhere = {
      organization_id: orgId,
      OR: [
        { entity_type: 'LEAD' as const, entity_id: ID_IN(leadIds) },
        { entity_type: 'ESTIMATE' as const, entity_id: ID_IN(estimateIds) },
        { entity_type: 'JOB' as const, entity_id: ID_IN(jobIds) },
        { entity_type: 'INVOICE' as const, entity_id: ID_IN(invoiceIds) },
      ],
    };
    await tx.attachment.deleteMany({ where: polyWhere as any });
    await tx.note.deleteMany({ where: polyWhere as any });
    await tx.timelineEvent.deleteMany({ where: polyWhere as any });
  }

  // STEP 5 — Financial spine, deepest first.
  if (invoiceIds.length) {
    await tx.depositCreditApplication.deleteMany({
      where: { OR: [{ deposit_invoice_id: ID_IN(invoiceIds) }, { target_invoice_id: ID_IN(invoiceIds) }] },
    });
    await tx.refund.deleteMany({ where: { invoice_id: ID_IN(invoiceIds) } });
    await tx.credit.deleteMany({ where: { invoice_id: ID_IN(invoiceIds) } });
    await tx.payment.deleteMany({ where: { invoice_id: ID_IN(invoiceIds) } });
    await tx.invoiceLineItem.deleteMany({ where: { invoice_id: ID_IN(invoiceIds) } });
    await tx.invoice.deleteMany({ where: { id: ID_IN(invoiceIds), organization_id: orgId } });
  }

  // Multi-visit S1: visits are deleted EXPLICITLY rather than left to cascade. Both parent FKs
  // (lead_id, job_id) are nullable - exactly one is set, enforced by a DB CHECK - so no single
  // non-null FK proves the cascade to the purge-coverage checker, even though every row does in
  // fact hang off a purged parent. Deleting them here states the intent instead of relying on it.
  if (leadIds.length || jobIds.length) {
    await tx.visitAssignee.deleteMany({
      where: { organization_id: orgId, visit: { OR: [{ lead_id: ID_IN(leadIds) }, { job_id: ID_IN(jobIds) }] } },
    });
    await tx.visit.deleteMany({
      where: { organization_id: orgId, OR: [{ lead_id: ID_IN(leadIds) }, { job_id: ID_IN(jobIds) }] },
    });
  }

  if (jobIds.length) {
    await tx.job.deleteMany({ where: { id: ID_IN(jobIds), organization_id: orgId } });
  }

  if (estimateIds.length) {
    await tx.estimateLineItem.deleteMany({ where: { estimate_id: ID_IN(estimateIds) } });
    await tx.estimateSendConfig.deleteMany({ where: { estimate_id: ID_IN(estimateIds) } });
    await tx.estimate.deleteMany({ where: { id: ID_IN(estimateIds), organization_id: orgId } });
  }

  if (leadIds.length) {
    await tx.lead.deleteMany({ where: { id: ID_IN(leadIds), organization_id: orgId } });
  }
}

// ─── Customer subtree purge ─────────────────────────────

/**
 * Hard-delete a Customer and the entire subtree it anchors. Members (independent
 * customers whose parent_id points here) are NOT deleted — the controller blocks
 * purge while members exist; at the DB the self-FK SetNulls.
 */
export async function purgeCustomerSubtree(tx: Tx, customerId: string, orgId: string): Promise<void> {
  // Resolve subtree id-sets up front.
  const leads = await tx.lead.findMany({ where: { customer_id: customerId, organization_id: orgId }, select: { id: true } });
  const leadIds = leads.map((l) => l.id);

  // Estimates are reached via their (mandatory) lead — Estimate.customer_id is gone (Phase D).
  const estimates = await tx.estimate.findMany({
    where: { organization_id: orgId, lead_id: ID_IN(leadIds) },
    select: { id: true },
  });
  const estimateIds = estimates.map((e) => e.id);

  const jobs = await tx.job.findMany({ where: { customer_id: customerId, organization_id: orgId }, select: { id: true } });
  const jobIds = jobs.map((j) => j.id);

  const invoices = await tx.invoice.findMany({
    where: {
      organization_id: orgId,
      OR: [{ customer_id: customerId }, { job_id: ID_IN(jobIds) }, { estimate_id: ID_IN(estimateIds) }],
    },
    select: { id: true },
  });
  const invoiceIds = invoices.map((i) => i.id);

  // Shared children + spine.
  await purgeSubtreeChildren(tx, orgId, { leadIds, estimateIds, jobIds, invoiceIds });

  // Customer-anchored comms not covered above (customer_id directly).
  const threads = await tx.messageThread.findMany({ where: { organization_id: orgId, customer_id: customerId }, select: { id: true } });
  const threadIds = threads.map((t) => t.id);
  if (threadIds.length) await tx.message.deleteMany({ where: { organization_id: orgId, thread_id: ID_IN(threadIds) } });
  await tx.messageThread.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });

  const chats = await tx.whatsAppChat.findMany({ where: { organization_id: orgId, customer_id: customerId }, select: { id: true } });
  const chatIds = chats.map((c) => c.id);
  if (chatIds.length) await tx.whatsAppMessage.deleteMany({ where: { organization_id: orgId, chat_id: ID_IN(chatIds) } });
  await tx.whatsAppChat.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });

  await tx.callSession.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });
  await tx.email.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });

  // Manual communication log entries anchored on the CUSTOMER itself (#2021). The sweep in
  // purgeSubtreeChildren reaches entries by LEAD id and JOB id - the only two anchors that
  // existed when it was written - and a customer-anchored entry hangs off neither, so without
  // this line it survives a purge whose caller was told it succeeded.
  //
  // The tenant-coverage guard cannot catch that gap: it asks whether the MODEL is written to,
  // and ManualCommunicationLog already is. Its FK does cascade, so the row would go with the
  // customer row deleted at the foot of this function; deleting it explicitly here follows the
  // same children-before-parents discipline as every other line in this block.
  await tx.manualCommunicationLog.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });

  // Customer-anchored inventory (customer_id directly).
  await tx.reservationLine.deleteMany({ where: { organization_id: orgId, estimate_reservation: { customer_id: customerId } } });
  await tx.estimateReservation.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });
  await tx.rfqLine.deleteMany({ where: { organization_id: orgId, rfq: { customer_id: customerId } } });
  await tx.rfqQuote.deleteMany({ where: { organization_id: orgId, rfq: { customer_id: customerId } } });
  await tx.rfq.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });
  await tx.purchaseOrderLine.deleteMany({ where: { organization_id: orgId, purchase_order: { customer_id: customerId } } });
  await tx.purchaseOrder.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });
  await tx.jobStageLine.deleteMany({ where: { organization_id: orgId, job_stage: { customer_id: customerId } } });
  await tx.jobStageAttachment.deleteMany({ where: { organization_id: orgId, job_stage: { customer_id: customerId } } });
  await tx.stageAuditEntry.deleteMany({ where: { organization_id: orgId, job_stage: { customer_id: customerId } } });
  await tx.jobStage.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });
  await tx.stockApprovalModification.deleteMany({ where: { organization_id: orgId, stock_approval: { customer_id: customerId } } });
  await tx.stockApproval.deleteMany({ where: { organization_id: orgId, customer_id: customerId } });

  // Contacts + their channel identities (children before parents).
  await tx.channelIdentity.deleteMany({ where: { contact: { customer_id: customerId } } });
  await tx.contact.deleteMany({ where: { customer_id: customerId } });

  // Customer-level tags + polymorphic rows.
  await tx.tagAssignment.deleteMany({ where: { organization_id: orgId, entity_type: 'CUSTOMER', entity_id: customerId } });
  const custPoly = { organization_id: orgId, entity_type: 'CUSTOMER' as const, entity_id: customerId };
  await tx.attachment.deleteMany({ where: custPoly as any });
  await tx.note.deleteMany({ where: custPoly as any });
  await tx.timelineEvent.deleteMany({ where: custPoly as any });

  // Customer-owned leaves, then root.
  await tx.customerPhone.deleteMany({ where: { customer_id: customerId } });
  await tx.customerEmail.deleteMany({ where: { customer_id: customerId } });
  await tx.serviceLocation.deleteMany({ where: { customer_id: customerId } });
  await tx.customer.delete({ where: { id: customerId } });
}

// ─── Lead subtree purge (reused by Phase 4 lead force-purge) ───

/**
 * Hard-delete a single Lead and everything it anchors (estimates/jobs/invoices and
 * their children) WITHOUT touching the parent Customer or its owned leaves.
 */
export async function purgeLeadSubtree(tx: Tx, leadId: string, orgId: string): Promise<void> {
  const leadIds = [leadId];

  const estimates = await tx.estimate.findMany({
    where: { organization_id: orgId, lead_id: ID_IN(leadIds) },
    select: { id: true },
  });
  const estimateIds = estimates.map((e) => e.id);

  // Jobs anchored by the lead's estimates (jobs have no lead_id — they reach a lead
  // only via estimate.lead). Resolve via estimate_id.
  const jobs = estimateIds.length
    ? await tx.job.findMany({ where: { organization_id: orgId, estimate_id: ID_IN(estimateIds) }, select: { id: true } })
    : [];
  const jobIds = jobs.map((j) => j.id);

  const invoices = await tx.invoice.findMany({
    where: { organization_id: orgId, OR: [{ job_id: ID_IN(jobIds) }, { estimate_id: ID_IN(estimateIds) }] },
    select: { id: true },
  });
  const invoiceIds = invoices.map((i) => i.id);

  await purgeSubtreeChildren(tx, orgId, { leadIds, estimateIds, jobIds, invoiceIds });
}

// ─── Purge coverage allowlist (#869) ────────────────────
//
// Every model carrying a tenant column (`organization_id` OR `org_id`) must be reachable by a
// purge: deleted here, cascaded from something deleted here, or listed below with a reason.
// `purge-tenant-coverage.test.ts` fails the build on any model that satisfies none of the three,
// which is what stops the next org-scoped table from silently regressing into an orphan.
//
// An entry here is a data-retention decision, so it must state one. The guard rejects
// placeholder reasons, entries naming models that no longer exist, and entries for models purge
// has since started covering (a dead exemption is where a real gap hides).

/** Deferred to #1027: RESTRICT FK to organizations - purge THROWS P2003, it does not orphan. */
const RESTRICT_1027 =
  'Deferred to #1027 - RESTRICT FK to organizations, so purge throws P2003 rather than orphaning. Loud failure, not residual data.';

export const PURGE_EXEMPT: Record<string, string> = {
  // ── The open question on #869. NOT a decision - the absence of one, made visible.
  // These two survive a purge today by accident: not retained by policy, not deleted by policy.
  // audit_logs is documented append-only and deliberately FK-free so history outlives the actor;
  // terms_acceptances is the org's own contract evidence (disclosed_fee_bps = the rate the admin
  // was actually shown, authority_attested = the "I can bind this org" checkbox). Deleting that
  // on request destroys the org's proof of what it agreed to. Costs nothing today - purge has one
  // caller (teardownTestOrg) and only ever reaches `e2e-qa-` fixture data - but the answer has to
  // be Ran's before it is written into code, so do not add deletes assuming either one.
  AuditLog:
    'PENDING DECISION - see #869 open question. Documented append-only, deliberately FK-free so audit history outlives the actor.',
  TermsAcceptance:
    'PENDING DECISION - see #869 open question. Holds contract evidence (disclosed_fee_bps, authority_attested) the org may need as proof.',

  // ── #1027: 40 org-scoped models with a RESTRICT FK to organizations. Different failure mode
  // entirely from the orphan class above - the
  // transaction rolls back loudly instead of leaving data behind. They come out of this list as
  // that issue is worked, and the "dead exemptions" guard forces exactly that.
  ScopePreset: RESTRICT_1027,
  JobSubStatus: RESTRICT_1027,
  ServicePlan: RESTRICT_1027,
  ServicePlanLineItem: RESTRICT_1027,
  ServicePlanMaterialLine: RESTRICT_1027,
  PlanVisit: RESTRICT_1027,
  ServicePlanTemplate: RESTRICT_1027,
  ServicePlanTemplateLineItem: RESTRICT_1027,
  OrgTaxRate: RESTRICT_1027,
  Brand: RESTRICT_1027,
  Vendor: RESTRICT_1027,
  VendorContact: RESTRICT_1027,
  Branch: RESTRICT_1027,
  InventoryLocation: RESTRICT_1027,
  StockMovement: RESTRICT_1027,
  Asset: RESTRICT_1027,
  AssetEvent: RESTRICT_1027,
  InventoryEmail: RESTRICT_1027,
  ItemGroup: RESTRICT_1027,
  ItemGroupLine: RESTRICT_1027,
  LogisticOrder: RESTRICT_1027,
  LogisticOrderLine: RESTRICT_1027,
  PhoneAgent: RESTRICT_1027,
  BlockedNumber: RESTRICT_1027,
  TextTemplate: RESTRICT_1027,
  TextAutomation: RESTRICT_1027,
  EmailGroup: RESTRICT_1027,
  EmailForwardRule: RESTRICT_1027,
  CallFlow: RESTRICT_1027,
  PhoneNumber: RESTRICT_1027,
  PendingCallAttribution: RESTRICT_1027,
  CallGroup: RESTRICT_1027,
  TrainingScenario: RESTRICT_1027,
  TrainingSession: RESTRICT_1027,
  TimeEntry: RESTRICT_1027,
  GeofenceConfig: RESTRICT_1027,
  GeofenceStore: RESTRICT_1027,
  TimeClockOtReview: RESTRICT_1027,
  AutomationRule: RESTRICT_1027,
  AutomationRun: RESTRICT_1027,
  // Custom fields MVP (SRVW-114 slice 1): same RESTRICT FK to organizations as
  // every other #1027 entry above (see custom_field_definitions_organization_id_fkey).
  CustomFieldDefinition: RESTRICT_1027,

  // ── Email slice 4: a deliberate, permanent exemption (not a RESTRICT_1027 FK
  // gap and not a #869 pending decision) - EmailSuppression.organization_id
  // carries no FK to organizations at all, by design. It is an audit
  // breadcrumb only (which org's send first surfaced a hard bounce/complaint),
  // never part of the suppression lookup itself, which is intentionally
  // GLOBAL by address: the shared mail.servwave.com sending domain means a
  // hard-bounced/complained address is broken for every org, not just the one
  // whose send triggered it. Purging one org must never delete a row that may
  // still be protecting every OTHER org from mailing the same dead address.
  EmailSuppression:
    'Deliberately global by address (email slice 4) - organization_id is an audit breadcrumb only, ' +
    'never part of the suppression lookup, and a purged org must not delete a row still protecting ' +
    'other orgs from the same hard-bounced/complained address on the shared sending domain.',
};

// ─── Organization purge (E2E teardown only) ─────────────
//
// Name-guarded full-org wipe. Purges every customer subtree (financial spine +
// comms + inventory via purgeCustomerSubtree), then the org-level rows that FK
// the organization, then the Organization. Refuses unless the org name starts
// with `nameGuard` so it can NEVER delete the demo / a real tenant.
export async function purgeOrganization(tx: Tx, orgId: string, nameGuard: string): Promise<void> {
  const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } });
  if (!org) return;
  if (!org.name.startsWith(nameGuard)) {
    throw new Error(`Refusing to purge org ${orgId}: name "${org.name}" does not start with guard "${nameGuard}"`);
  }

  // 1. Every customer subtree (bill_to/parent self-FKs SetNull at the DB, so order-free).
  const customers = await tx.customer.findMany({ where: { organization_id: orgId }, select: { id: true } });
  for (const c of customers) {
    await purgeCustomerSubtree(tx, c.id, orgId);
  }

  // 2. Org-level rows. deleteMany on empty tables is a harmless no-op; this also
  //    covers org-scoped timeline/attachments/notes not anchored to a customer.
  await tx.userTablePreference.deleteMany({ where: { user: { organization_id: orgId } } });
  await tx.appSetting.deleteMany({ where: { organization_id: orgId } });
  await tx.rolePermission.deleteMany({ where: { organization_id: orgId } });
  await tx.tagAssignment.deleteMany({ where: { organization_id: orgId } });
  await tx.tag.deleteMany({ where: { organization_id: orgId } });
  await tx.attachment.deleteMany({ where: { organization_id: orgId } });
  await tx.note.deleteMany({ where: { organization_id: orgId } });
  await tx.timelineEvent.deleteMany({ where: { organization_id: orgId } });
  await tx.priceBookItem.deleteMany({ where: { organization_id: orgId } });
  await tx.priceBookCategory.deleteMany({ where: { organization_id: orgId } });
  // Ordered AFTER priceBookItem: price_book_items.finish_id is ON DELETE SET
  // NULL, so deleting finishes first would needlessly rewrite every item row on
  // its way to deleting them. UomOption has no dependents at all - items store
  // the unit CODE string, not a foreign key to it.
  //
  // Unlike Brand, which is still parked in PURGE_EXEMPT under #1027, these two
  // are deleted for real: they are new, nothing outside this pass points at
  // them, and there was no reason to grow that backlog.
  await tx.finish.deleteMany({ where: { organization_id: orgId } });
  await tx.uomOption.deleteMany({ where: { organization_id: orgId } });
  // Email slice 8b: EmailThread carries organization_id and a real FK to
  // Organization, but nothing cascades INTO it - Email.thread_id -> EmailThread
  // is the other direction (ON DELETE SET NULL FROM EmailThread, not a cascade
  // that reaches it), so an unlisted org purge would leave every thread row
  // behind, RLS-invisible forever (#869's exact defect class). Order-free vs.
  // the customer-subtree pass above: deleting a thread never touches the Email
  // rows that reference it (their thread_id just has nothing left to point at
  // if a later slice re-nulls it; nothing here relies on that ordering).
  // Email slice 6: reply_tokens BEFORE email_threads. Its org FK is ON DELETE
  // RESTRICT, so a leftover token does not merely orphan - it makes the final
  // Organization delete fail outright and takes the whole purge with it. Going
  // first also skips a pointless SET NULL pass over thread_id on rows that are
  // about to be deleted anyway.
  await tx.replyToken.deleteMany({ where: { organization_id: orgId } });
  await tx.emailThread.deleteMany({ where: { organization_id: orgId } });
  // External call-tracking receiver rows (URL token + vendor signing key per
  // org). Org FK is ON DELETE RESTRICT, so a leftover row would fail the final
  // Organization delete; nothing references them, order-free otherwise.
  await tx.callTrackingIntegration.deleteMany({ where: { organization_id: orgId } });
  // Website-form intake (web-form lead intake slice 1): the per-org URL token row and the
  // submission ledger it claims against. Both org FKs are ON DELETE RESTRICT, so either one left
  // behind fails the final Organization delete. Submissions go first - they are the child in
  // meaning even though no FK ties them - and a submission row also holds the raw payload, which
  // is real customer-supplied content rather than merely a dangling id.
  await tx.webFormSubmission.deleteMany({ where: { organization_id: orgId } });
  await tx.webFormIntegration.deleteMany({ where: { organization_id: orgId } });
  // The per-org estimate decline reason list (decline-reasons slice B). Its org FK is ON DELETE
  // RESTRICT, so a leftover row does not merely orphan - it makes the final Organization delete
  // fail and takes the whole purge down with it. Nothing points AT these rows: an estimate
  // stores the decline CODE STRING, not a foreign key, so order is free otherwise.
  await tx.lostReasonOption.deleteMany({ where: { organization_id: orgId } });
  // Task categories (visits-and-task-categories slice 08). The org FK cascades, so the final
  // Organization delete would take them anyway; deleted explicitly so the purge's own record of
  // what it removes stays complete. tasks.category_id is ON DELETE SET NULL - order-free.
  await tx.taskCategory.deleteMany({ where: { organization_id: orgId } });

  // 2b. Tables that carry `organization_id` but have NO relation to Organization (#869).
  //     Nothing at the DB level cleans these up, so a SUCCESSFUL purge used to leave every row
  //     behind pointing at an org id that no longer exists - and RLS is ENABLE+FORCE on
  //     `organization_id` for all of them, so an orphan is invisible to the app connection and
  //     not even the tenant-scoped delete route can reach it. Only raw SQL could.
  //
  //     Order is child-first, matching deleteWorkflow (workflow.controller.ts) and
  //     reseed-builtin-keys.ts. One edge is load-bearing rather than cosmetic:
  //     `workflow_enrollments_workflow_version_id_fkey` is ON DELETE RESTRICT, which Postgres
  //     checks immediately and cannot defer - enrollments MUST go before versions.
  //     `workflows.published_version_id` needs no null-out first: it carries no FK constraint
  //     (workflow_builder_tables/migration.sql) and the row is deleted outright anyway.
  await tx.workflowStepRun.deleteMany({ where: { organization_id: orgId } });
  await tx.workflowEnrollment.deleteMany({ where: { organization_id: orgId } });
  await tx.workflowVersion.deleteMany({ where: { organization_id: orgId } });
  await tx.workflowStep.deleteMany({ where: { organization_id: orgId } });
  await tx.workflow.deleteMany({ where: { organization_id: orgId } });
  //     Copilot: messages hold real user conversation content (`content @db.Text`), so this is
  //     residual data, not merely dangling rows. The scalar organization_id/user_id there are a
  //     documented modularity choice ("keep this module self-contained"), not a retention one.
  await tx.copilotMessage.deleteMany({ where: { organization_id: orgId } });
  await tx.copilotConversation.deleteMany({ where: { organization_id: orgId } });
  await tx.copilotAuditEvent.deleteMany({ where: { organization_id: orgId } });

  //     Calendar Entries (Slice 02, #869 same defect class): calendar_entries carries
  //     organization_id as a plain column with NO relation to Organization (mirrors
  //     NotificationRecipient / TermsAcceptance - see the schema.prisma header comment on
  //     CalendarEntry), so nothing at the DB level cleans it up on an org purge. Deleted here,
  //     explicitly. calendar_entry_participants needs NO explicit delete of its own: its FK to
  //     calendar_entries is a REQUIRED `onDelete: Cascade` relation, so Postgres removes those
  //     rows the instant the parent row goes - purge-tenant-coverage.test.ts's cascade closure
  //     recognises this edge and covers it without a second deleteMany.
  await tx.calendarEntry.deleteMany({ where: { organization_id: orgId } });

  //     Message threads with NO customer and NO lead. The two sweeps above reach a thread
  //     only through a lead (purgeSubtreeChildren) or a customer (purgeCustomerSubtree), so
  //     any other thread survives both - and MessageThread.organization is a REQUIRED
  //     relation with no onDelete, i.e. RESTRICT, so a survivor does not merely orphan: it
  //     makes the Organization delete below throw and rolls the entire purge back.
  //
  //     Two kinds of thread land here. One already exists today: findOrCreateSmsThreadByNumber
  //     creates a thread with no customer/lead/vendor when an inbound number matches nobody.
  //     The other is the staff thread (Spec C), keyed on a user - and because that FK is
  //     ON DELETE SET NULL, `tx.user.deleteMany` below would NULL its user_id and leave the
  //     thread behind rather than removing it.
  //
  //     Ordered BEFORE the user delete on purpose. An org-scoped sweep would clear the row
  //     from either position while the user FK stays SET NULL, but running first keeps the
  //     fix independent of that: were the FK ever tightened to RESTRICT, a sweep sitting
  //     after the user delete would resurrect the failure.
  //
  //     Messages before threads - messages.thread_id references the row being deleted.
  await tx.message.deleteMany({ where: { organization_id: orgId } });
  await tx.messageThread.deleteMany({ where: { organization_id: orgId } });

  // 3. Users (Restrict→org) and departments (Restrict→org) before the org; locations Cascade.
  await tx.user.deleteMany({ where: { organization_id: orgId } });
  await tx.department.deleteMany({ where: { organization_id: orgId } });
  await tx.location.deleteMany({ where: { organization_id: orgId } });

  // 4. The org.
  await tx.organization.delete({ where: { id: orgId } });
}
