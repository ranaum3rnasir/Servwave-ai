/**
 * Copilot capability registry — the backend source of truth for "what Servy can
 * do". Each row maps an intent to the real ServWave endpoint behind it, the
 * CASL subject/action that gates it, whether it requires an approval card, and
 * its execution mode (read vs write vs draft). The browser tool registry mirrors
 * these rows (with JSON-Schema arg shapes); the persona lists them so the model
 * never advertises a capability that does not exist ("no false capabilities").
 */

export type ExecutionMode = 'read' | 'write' | 'draft';

export interface Capability {
  id: string;
  label: string;
  /** What the user asks for, in plain language (drives the persona summary). */
  intent: string;
  endpoint: string; // method + path, or 'n/a' for client-only (draft)
  mode: ExecutionMode;
  /** CASL subject + action enforced server-side at the endpoint. */
  subject: string | null;
  action: string | null;
  /** Writes require a confirmation card; reads/drafts do not. */
  requiresApproval: boolean;
  status: 'live' | 'partial';
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'query_crm',
    label: 'Answer questions about your CRM',
    intent: 'look up jobs, leads, estimates, invoices, customers and search',
    endpoint: 'GET /api/{jobs,leads,estimates,invoices,customers,search}',
    mode: 'read',
    subject: null,
    action: 'read',
    requiresApproval: false,
    status: 'live',
  },
  {
    id: 'get_briefing',
    label: 'Daily briefing',
    intent: 'summarise KPIs, cash, schedule and what needs attention',
    endpoint: 'GET /api/dashboard',
    mode: 'read',
    subject: 'Dashboard',
    action: 'read',
    requiresApproval: false,
    status: 'live',
  },
  {
    id: 'list_users',
    label: 'Look up staff',
    intent: 'resolve a staff name to the user id needed for assignments and filters',
    endpoint: 'GET /api/users',
    mode: 'read',
    subject: 'User',
    action: 'read',
    requiresApproval: false,
    status: 'live',
  },
  {
    id: 'create_lead',
    label: 'Create a lead',
    intent: 'capture a new lead for an existing or new customer',
    endpoint: 'POST /api/leads',
    mode: 'write',
    subject: 'Lead',
    action: 'create',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'mark_lead_contacted',
    label: 'Mark a lead contacted',
    intent: 'record first contact on a NEW lead (required before scheduling its walkthrough)',
    endpoint: 'POST /api/leads/:id/contact',
    mode: 'write',
    subject: 'Lead',
    action: 'contact',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'schedule_walkthrough',
    label: 'Schedule a walkthrough',
    intent: 'schedule, move or unschedule a lead walkthrough with its performers',
    endpoint: 'POST /api/leads/:id/walkthrough/{schedule,unschedule}',
    mode: 'write',
    subject: 'Lead',
    action: 'schedule_walkthrough',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'create_estimate',
    label: 'Create an estimate',
    intent: 'quote a lead with line items',
    endpoint: 'POST /api/estimates',
    mode: 'write',
    subject: 'Estimate',
    action: 'create',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'create_job',
    label: 'Create a job',
    intent: 'turn an approved estimate (or a customer + location) into a job',
    endpoint: 'POST /api/jobs',
    mode: 'write',
    subject: 'Job',
    action: 'create',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'create_invoice',
    label: 'Create an invoice',
    intent: 'bill a job from its Items tab (all line items, one active invoice per job)',
    endpoint: 'POST /api/invoices',
    mode: 'write',
    subject: 'Invoice',
    action: 'create',
    requiresApproval: true,
    status: 'partial', // job_id only; no standalone (customer-anchored) or progress-draw path exposed
  },
  {
    id: 'update_job_status',
    label: 'Update a job status',
    intent: 'schedule + set the crew (assign), start, complete, cancel or reopen a job',
    endpoint: 'POST /api/jobs/:id/{assign,start,complete,cancel,reopen,en-route,arrive,unassign}',
    mode: 'write',
    subject: 'Job',
    action: 'update',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'reschedule_job',
    label: 'Reschedule a job',
    intent: 'move a job to a new date/time (keeps the crew, notifies the customer)',
    endpoint: 'POST /api/jobs/:id/assign',
    mode: 'write',
    subject: 'Job',
    action: 'update',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'update_estimate_status',
    label: 'Send or cancel an estimate',
    intent: 'send an estimate to the customer (asks the deposit decision first), or cancel it',
    endpoint: 'POST /api/estimates/:id/{send,cancel}',
    mode: 'write',
    subject: 'Estimate',
    action: 'update',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'add_note',
    label: 'Add a note',
    intent: 'attach a note to a lead, customer, job, estimate or invoice',
    endpoint: 'POST /api/{leads,customers,jobs,estimates,invoices}/:id/notes',
    mode: 'write',
    subject: null,
    action: 'update',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'create_customer',
    label: 'Create a customer',
    intent: 'add a new customer record',
    endpoint: 'POST /api/customers',
    mode: 'write',
    subject: 'Customer',
    action: 'create',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'update_customer',
    label: 'Update a customer',
    intent: 'edit an existing customer record',
    endpoint: 'PATCH /api/customers/:id',
    mode: 'write',
    subject: 'Customer',
    action: 'update',
    requiresApproval: true,
    status: 'live',
  },
  {
    id: 'draft_message',
    label: 'Draft a message',
    intent: 'write a customer/technician/reminder message for the user to send manually',
    endpoint: 'n/a',
    mode: 'draft',
    subject: null,
    action: null,
    requiresApproval: false,
    status: 'live',
  },
];

export function listCapabilities(): Capability[] {
  return CAPABILITIES;
}

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}
