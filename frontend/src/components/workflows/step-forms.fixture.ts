import type { WorkflowCatalog } from '@/lib/api/workflows';

/** A trimmed but shape-faithful catalog for the step-form component tests. */
export const FORM_CATALOG = {
  triggers: {
    JOB_SCHEDULED: {
      label: 'Job is scheduled',
      description: 'Fires when a job gets a date.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: ['customer.first_name', 'job.number'],
    },
    BEFORE_JOB_START: {
      label: 'Before a job starts',
      description: 'Fires a set time before the job’s scheduled start.',
      category: 'timed',
      entity: 'job',
      timeBased: true,
      defaultOffsetMinutes: 24 * 60,
      mergeFields: ['customer.first_name', 'job.number'],
    },
    INVOICE_PAID: {
      label: 'Invoice is paid',
      description: 'Fires when an invoice is paid in full.',
      category: 'events',
      entity: 'invoice',
      timeBased: false,
      mergeFields: ['customer.first_name', 'invoice.number'],
    },
    LEAD_CREATED: {
      label: 'Lead is created',
      description: 'Fires when a new lead is created.',
      category: 'events',
      entity: 'lead',
      timeBased: false,
      mergeFields: ['lead.name'],
    },
  },
  actions: {
    SEND_EMAIL: {
      label: 'Send an email',
      description: '',
      recipients: ['customer', 'assigned_techs', 'all_admins', 'all_dispatchers', 'custom'],
      requiresSubject: true,
    },
    // `recipients` here is the LEGACY six-member RecipientKey list, and it is still
    // customer-only on purpose: Spec C widened audiencesFor() (what the builder reads) and
    // deliberately left catalog.ts's ACTIONS.SEND_SMS.recipients alone, since no frontend file
    // reads catalog.actions[...]. The audiences a text step actually offers live under
    // `audiences[trigger].SEND_SMS`, which this trimmed fixture predates - the suites that
    // need it layer it on. Do not "fix" this line to match the picker.
    SEND_SMS: { label: 'Send a text', description: '', recipients: ['customer'], requiresSubject: false },
  },
  merge_field_labels: {
    'customer.first_name': 'Customer first name',
    'job.number': 'Job number',
    'invoice.number': 'Invoice number',
    'lead.name': 'Lead name',
  },
  sample_context: {},
  templates: [],
  stop_if: {
    conditions: {
      invoice: ['invoice_paid', 'invoice_not_open'],
      estimate: ['estimate_answered', 'estimate_approved', 'estimate_declined'],
      job: ['job_cancelled', 'job_completed', 'job_rescheduled'],
      lead: [],
    },
    labels: {
      invoice_paid: 'the invoice is paid',
      invoice_not_open: 'the invoice is no longer open',
      job_completed: 'the job was completed',
    },
  },
} as unknown as WorkflowCatalog;
