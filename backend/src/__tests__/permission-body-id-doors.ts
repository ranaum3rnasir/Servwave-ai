/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 47): every request field that names a record by id.

   Not a test file. The guard (permission-body-id-guard.test.ts) reads every request schema, `req.body.<field>` and
   query-string read (`req.query.<field>`, destructured or through an alias) in the backend for fields that name a record with reach (a job, lead, estimate, invoice, customer, task, stage, order, payment
   item, message...) and requires each to be listed here: COVERED by a database test row that proves a record out of the
   person's reach answers exactly like a missing one, with nothing written, or ALLOWED with the reason it is not about
   reach. A new field that is neither fails the guard.

   A key is `<file>#<schema const>.<field>` for a schema field, `<file>#req.body.<field>` for a field read off the body, or
   `<file>#req.query.<field>` for one read off the query string.
   ========================================================================== */

/** The database test file whose table row covers the key. */
export type CoveringTest = 'permission-body-id-not-found-db.test.ts' | 'permission-bulk-not-found-db.test.ts';

const BODY: CoveringTest = 'permission-body-id-not-found-db.test.ts';
const BULK: CoveringTest = 'permission-bulk-not-found-db.test.ts';

export const COVERED: Record<string, CoveringTest> = {
  // Invoices
  'src/controllers/invoice.controller.ts#createInvoiceSchema.job_id': BODY,
  'src/controllers/invoice.controller.ts#createInvoiceSchema.unapplied_capture_id': BODY,
  'src/controllers/invoice.controller.ts#bulkSendInvoicesSchema.ids': BULK,
  // Estimates
  'src/controllers/estimate.controller.ts#createEstimateSchema.lead_id': BODY,
  'src/controllers/estimate.controller.ts#createEstimateSchema.job_id': BODY,
  'src/controllers/estimate.controller.ts#attachToJobSchema.job_id': BODY,
  'src/controllers/estimate.controller.ts#bulkDeleteEstimatesSchema.ids': BULK,
  'src/controllers/estimate.controller.ts#bulkSetEstimateStatusSchema.ids': BULK,
  'src/controllers/estimate.controller.ts#bulkSendEstimateRemindersSchema.ids': BULK,
  // The price-book image upload names the estimate the picture comes from (re-audit P2-4; a multipart field).
  'src/controllers/price-book-image.controller.ts#req.body.estimate_id': BODY,
  // Jobs
  'src/controllers/job.controller.ts#createJobSchema.estimate_id': BULK,
  'src/controllers/job.controller.ts#createJobSchema.estimate_ids': BULK,
  'src/controllers/job.controller.ts#bulkStatusJobsSchema.ids': BULK,
  'src/controllers/job.controller.ts#bulkAssignJobsSchema.ids': BULK,
  'src/controllers/job.controller.ts#cancelPreviewQuerySchema.ids': BULK,
  // Customers
  'src/controllers/tag.controller.ts#bulkTagEntitySchema.ids': BULK,
  'src/controllers/customer.controller.ts#redesignFields.parent_id': BODY,
  // Tasks, calendar entries, service plans
  'src/controllers/task.controller.ts#createTaskSchema.linked_entity_id': BODY,
  // Editing a service plan refuses its customer and address with one answer for every id (ticket 33b)
  'src/controllers/service-plan.controller.ts#updatePlanSchema.customer_id': BODY,
  'src/controllers/service-plan.controller.ts#updatePlanSchema.service_location_id': BODY,
  // Query-string ids
  'src/controllers/task.controller.ts#req.query.entity_id': BODY,
  'src/controllers/task.controller.ts#req.query.linked_entity_id': BODY,
  'src/controllers/calendar-entry.controller.ts#req.query.customer_id': BODY,
  'src/controllers/inv-stages.controller.ts#req.query.job_id': BODY,
  // Logistic orders
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.job_id': BODY,
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.lead_id': BODY,
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.customer_id': BODY,
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.estimate_id': BULK,
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.invoice_id': BULK,
  // Purchase orders
  'src/controllers/inv-po.controller.ts#createPurchaseOrderSchema.jobId': BODY,
  'src/controllers/inv-po.controller.ts#createPurchaseOrderSchema.customerId': BODY,
  'src/controllers/inv-po.controller.ts#createPurchaseOrderFromJobSchema.jobId': BODY,
  'src/controllers/inv-po.controller.ts#updatePurchaseOrderSchema.jobId': BODY,
  'src/controllers/inv-po.controller.ts#updatePurchaseOrderSchema.customerId': BODY,
  'src/controllers/inv-po.controller.ts#receivePurchaseOrderSchema.poId': BODY,
  // Job stages
  'src/controllers/inv-stages.controller.ts#createStageSchema.jobId': BODY,
  'src/controllers/inv-stages.controller.ts#createStageSchema.customerId': BODY,
  'src/controllers/inv-stages.controller.ts#createStageSchema.stagedFromPurchaseOrderId': BODY,
  'src/controllers/inv-stages.controller.ts#createStageSchema.linkedPurchaseOrderId': BODY,
  'src/controllers/inv-stages.controller.ts#updateStageSchema.jobId': BODY,
  'src/controllers/inv-stages.controller.ts#updateStageSchema.customerId': BODY,
  'src/controllers/inv-stages.controller.ts#receiveStageSchema.stageId': BODY,
  'src/controllers/inv-stages.controller.ts#notifyStageSchema.stageId': BODY,
  'src/controllers/inv-stages.controller.ts#emailStageSchema.stageId': BODY,
  // Payments needing attention
  'src/controllers/payment-attention.controller.ts#attachBodySchema.invoice_id': BODY,
};

const PICKER =
  'customer pickers in the create forms are open (ruling 2026-09-10, #2041 decision 8): a rep may book onto any existing ' +
  'customer; nothing is written onto a customer they cannot read (the lead create accretion row proves it for leads)';
const TICKET_32 = 'ticket 32 (communication writes)';
const PICKER_FORM =
  "the form picks this customer from the org-wide picker (/api/customers/picker), so saving accepts any customer it offers " +
  "(Ran's picker ruling, 2026-10-28); a missing or another company's customer is refused like a missing one, and the answer " +
  'shows no more of a customer the person cannot read than the picker does (permission-body-id-not-found-db.test.ts)';

export const ALLOWED: Record<string, string> = {
  'src/controllers/service-plan.controller.ts#planObject.customer_id': 'CREATE only (updatePlanSchema refuses it, ticket 33b): ' + PICKER_FORM,
  'src/controllers/calendar-entry.controller.ts#participantSchema.customer_id': PICKER_FORM,
  'src/controllers/payments-attention.controller.ts#req.query.payment_id':
    'the payments pages show an item on an invoice out of reach as restricted, by design (Payments build; raised with ticket 33)',
  'src/controllers/lead.controller.ts#createLeadSchema.customer_id': PICKER,
  'src/controllers/lead.controller.ts#leadExtraFields.service_location_id': 'a location of the picked customer: ' + PICKER,
  'src/controllers/job.controller.ts#createJobSchema.customer_id': PICKER,
  'src/controllers/job.controller.ts#createJobSchema.service_location_id': 'a location of the picked customer: ' + PICKER,
  'src/controllers/job.controller.ts#updateJobSchema.service_location_id': "a location of the job's own customer, which the job page already shows",
  'src/controllers/estimate.controller.ts#createEstimateSchema.customer_id': PICKER,
  'src/controllers/invoice.controller.ts#createInvoiceSchema.customer_id': 'the standalone invoice form uses the same customer picker (PICKER_GUARD): ' + PICKER,
  'src/controllers/invoice.controller.ts#createInvoiceSchema.service_location_id': 'a location of the picked customer: ' + PICKER,
  'src/controllers/service-plan.controller.ts#planObject.service_location_id': "CREATE only (updatePlanSchema refuses it, ticket 33b): must belong to the plan's customer (a picker customer); the answer shows only its city for a customer the person cannot read",
  'src/controllers/customer.controller.ts#redesignFields.bill_to_customer_id': 'may only be the customer itself or its parent, which is reach-checked; no other customer is looked up',
  'src/controllers/estimate.controller.ts#duplicateEstimateSchema.target_lead_id': 'ticket 32 (duplicate estimate)',
  'src/controllers/logistic-order.controller.ts#createLogisticOrderSchema.service_plan_id': 'service plans have no reach of their own: the plan switches open every plan',
  'src/controllers/logistic-order.controller.ts#listQuerySchema.job_id': 'a list filter over orders already narrowed to the reach (scopeWhereForReq LogisticOrder)',
  'src/controllers/logistic-order.controller.ts#listQuerySchema.invoice_id': 'a list filter over orders already narrowed to the reach (scopeWhereForReq LogisticOrder)',
  'src/controllers/logistic-order.controller.ts#listQuerySchema.service_plan_id': 'a list filter over orders already narrowed to the reach (scopeWhereForReq LogisticOrder)',
  'src/controllers/inv-po.controller.ts#createRfqSchema.jobId': 'RFQs are parked behind featureDisabled',
  'src/controllers/inv-po.controller.ts#createRfqSchema.customerId': 'RFQs are parked behind featureDisabled',
  'src/controllers/inv-po.controller.ts#updateRfqSchema.jobId': 'RFQs are parked behind featureDisabled',
  'src/controllers/inv-po.controller.ts#updateRfqSchema.customerId': 'RFQs are parked behind featureDisabled',
  'src/controllers/inv-stock.controller.ts#createApprovalSchema.jobId': 'schema mounted on no route',
  'src/controllers/inv-stock.controller.ts#createApprovalSchema.customerId': 'schema mounted on no route',
  'src/controllers/inv-stock.controller.ts#listMovementsQuerySchema.job_id': 'stock is company reference data with no scope (ruling 2026-09-10, item 023)',
  'src/controllers/inv-stock.controller.ts#listMovementsQuerySchema.logistic_order_id': 'stock is company reference data with no scope (ruling 2026-09-10, item 023)',
  'src/controllers/invoice.controller.ts#refundInvoiceSchema.payment_id': 'a payment of the invoice in the path, which the route reach-checks first',
  'src/controllers/invoice.controller.ts#cancelBankPaymentSchema.payment_id': 'a payment of the invoice in the path, which the route reach-checks first',
  'src/controllers/invoice.controller.ts#voidPaymentSchema.payment_id': 'a payment of the invoice in the path, which the route reach-checks first',
  'src/controllers/job-review.controller.ts#checkRequestSchema.entry_id': 'an entry of the job in the path, which the route reach-checks first',
  'src/controllers/job-review.controller.ts#decisionSchema.entry_id': 'an entry of the job in the path, which the route reach-checks first',
  'src/controllers/notification.controller.ts#seenSchema.ids': "the person's own bell",
  'src/controllers/price-book.controller.ts#createCategorySchema.parent_id': 'price book categories: company reference data with no scope',
  'src/controllers/price-book.controller.ts#updateCategorySchema.parent_id': 'price book categories: company reference data with no scope',
  'src/services/spider/config.ts#updateSpiderSettingsSchema.selected_lead_ids': 'Spider settings: Admin-only',
  'src/controllers/copilot.controller.ts#feedbackSchema.message_id': 'the copilot is not running (CLAUDE.md)',
  'src/controllers/copilot.controller.ts#req.body.message_id': 'the copilot is not running (CLAUDE.md)',
  'src/controllers/estimate.controller.ts#req.body.target_lead_id': 'ticket 32 (duplicate estimate)',
  'src/controllers/price-book.controller.ts#req.body.parent_id': 'price book categories: company reference data with no scope',
};

/** Every body id field in the communication controllers is ticket 32's. */
export const ALLOWED_FILES: Record<string, string> = {
  'src/controllers/comm-calls.controller.ts': TICKET_32,
  'src/controllers/comm-whatsapp-email.controller.ts': TICKET_32,
  'src/controllers/comm-threads.controller.ts': TICKET_32,
  'src/controllers/comm-manual-log.controller.ts': TICKET_32,
};

/** A field that names a record with reach (the suffix decides), or a list of record ids. */
export const RECORD_ID_FIELD =
  /\b([A-Za-z_]*?(?:job|lead|estimate|invoice|customer|task|stage|visit|asset|order|unapplied_capture|payment|entity|entry|thread|message|email|call|chat|plan|service_location|parent|po)(?:_id|_ids|Id|Ids)|ids)\s*:\s*z\b/gi;
/** A record id read off the query string: `req.query.<field>`. Destructured reads are found by the guard itself. */
export const RECORD_ID_QUERY_READ =
  /\breq\.query\??\.([A-Za-z_]*?(?:job|lead|estimate|invoice|customer|task|stage|visit|asset|order|unapplied_capture|payment|entity|entry|thread|message|email|call|chat|plan|service_location|parent|po)(?:_id|_ids|Id|Ids)|ids)\b/gi;
/** The same name test, for one destructured or aliased field. */
export const RECORD_ID_NAME =
  /^(?:[A-Za-z_]*?(?:job|lead|estimate|invoice|customer|task|stage|visit|asset|order|unapplied_capture|payment|entity|entry|thread|message|email|call|chat|plan|service_location|parent|po)(?:_id|_ids|Id|Ids)|ids)$/i;
export const RECORD_ID_BODY_READ =
  /\breq\.body\??\.([A-Za-z_]*?(?:job|lead|estimate|invoice|customer|task|stage|visit|asset|order|unapplied_capture|payment|entity|entry|thread|message|email|call|chat|plan|service_location|parent|po)(?:_id|_ids|Id|Ids)|ids)\b/gi;
