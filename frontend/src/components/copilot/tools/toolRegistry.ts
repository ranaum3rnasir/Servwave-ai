/**
 * Tool registry — the Gemini function declarations Servy can call, each mirroring
 * a real ServWave API body. Writes are pre-gated by the user's CASL ability so
 * the model is never even offered a tool the user can't use (the API enforces it
 * again server-side). The JSON schemas use additionalProperties:false + explicit
 * `required` so the model produces well-formed bodies.
 */
import type { AppAbility, AppAction, AppSubject } from '@/lib/ability';
import { STATUS_REGISTRY } from '@/design-system/status-registry';

export type ToolMode = 'read' | 'write' | 'draft';

/**
 * The status vocabulary Servy may filter a resource by, derived from the status
 * registry rather than spelled out by hand. Hand-spelling it drifted once
 * already: the estimates list was 7 of the 8 EstimateStatus values (SUPERSEDED
 * was missing), so the model reported that status did not exist while
 * /api/estimates would happily have filtered on it.
 *
 * The registry's key order is the enum's declaration order, so these strings
 * read the same way the schema does. `exclude` drops registry keys that are NOT
 * accepted by a list endpoint's `status` facet: every facet validates values
 * against the Prisma enum (see backend/src/lib/query/registries/*.filters.ts),
 * and invoice OVERDUE is client-derived from due_date, not an InvoiceStatus
 * value - it has its own `overdue` boolean parameter instead.
 *
 * CONTRACT, not decoration. This function makes STATUS_REGISTRY load-bearing for
 * an LLM-facing API filter contract, not just for appearance. For the `lead`,
 * `job`, `estimate` and `invoice` domains BOTH the key SET and the key ORDER are
 * part of that contract: the set is what Servy will send to
 * `GET /api/{resource}`, and the order is the sequence the model reads in the
 * tool description. Reordering or reformatting those maps in
 * design-system/status-registry.ts silently changes the advertised vocabulary
 * with no visual symptom on any screen.
 *
 * The `exclude` argument is therefore a SECOND source of truth, hand-maintained
 * here, for which registry keys are real Prisma enum values. Add a client-derived
 * key to a domain map for rendering (the `invoice.OVERDUE` pattern) and it is
 * advertised as a real filter value unless it is added to `exclude` in the same
 * change - and the facet rejects it with a 400 the model cannot anticipate.
 * Conversely a key removed from a map silently disappears from the vocabulary.
 *
 * Kept honest by the guard in
 * frontend/src/design-system/__tests__/status-registry-schema-guard.test.ts,
 * which parses backend/prisma/schema.prisma and asserts, for each of the four
 * domains, that the advertised vocabulary is exactly that domain's Prisma enum
 * values in declaration order. One equality covers every direction: a missing
 * value (the SUPERSEDED bug above), an extra value, a reordering, and a stale
 * `exclude`. This function is exported solely so that guard can assert against
 * the generator directly instead of string-matching the rendered description.
 */
export function statusVocabulary(
  domain: 'lead' | 'job' | 'estimate' | 'invoice',
  exclude: readonly string[] = [],
): string {
  return Object.keys(STATUS_REGISTRY[domain])
    .filter((value) => !exclude.includes(value))
    .join('|');
}

export interface ToolSpec {
  name: string;
  capabilityId: string;
  mode: ToolMode;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  /** CASL gate; undefined → always available. */
  gate?: { action: AppAction; subject: AppSubject };
}

const locationSchema = {
  type: 'object',
  properties: {
    address_line1: { type: 'string' },
    address_line2: { type: 'string' },
    city: { type: 'string' },
    state: { type: 'string', description: 'Two-letter state code' },
    zip: { type: 'string' },
  },
  required: ['address_line1', 'city', 'state', 'zip'],
  additionalProperties: false,
};

export const TOOL_SPECS: Record<string, ToolSpec> = {
  query_crm: {
    name: 'query_crm',
    capabilityId: 'query_crm',
    mode: 'read',
    description:
      'Look up CRM records. Use `query` to filter any resource by free text (names, record numbers, phone, addresses). Use `record_id` (an id from a previous result) to fetch ONE record\'s full details — customers include service locations, recent jobs and money totals; jobs include the crew; estimates include the deposit state; invoices include the payment ledger. resource=search sweeps all record types at once.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        resource: {
          type: 'string',
          enum: ['jobs', 'leads', 'estimates', 'invoices', 'customers', 'search'],
        },
        record_id: { type: 'string', description: 'Fetch full details of this one record (id from a previous tool result)' },
        query: { type: 'string', description: 'Free-text filter: customer name, record number, phone, address…' },
        status: {
          type: 'string',
          description:
            // Multi-visit S4 (D17): EN_ROUTE and ON_SITE are still KEYS of the `job` registry
            // block - they render the per-visit chips - but they retired from JobStatus, and the
            // jobs list facet now rejects them with a 400. Advertising them here would hand the
            // model two filter values guaranteed to fail, which is the exact class the comment
            // above this function describes. They are excluded the same way OVERDUE is.
            `Filter by status. leads: ${statusVocabulary('lead')}. jobs: ${statusVocabulary('job', ['EN_ROUTE', 'ON_SITE'])}. estimates: ${statusVocabulary('estimate')}. invoices: ${statusVocabulary('invoice', ['OVERDUE'])} (OVERDUE is NOT a status - use the overdue flag; "unpaid" = SENT or PARTIAL).`,
        },
        assigned_to: {
          type: 'string',
          description:
            'leads: owner user id, or the literal "UNSCHEDULED". jobs: a crew member\'s user id (for unassigned jobs use status=UNSCHEDULED instead). Get user ids from list_users.',
        },
        overdue: { type: 'boolean', description: 'Invoices only: overdue ones' },
        customer_id: { type: 'string' },
        scheduled_after: { type: 'string', description: 'ISO date-time' },
        scheduled_before: { type: 'string', description: 'ISO date-time' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },

  list_users: {
    name: 'list_users',
    capabilityId: 'list_users',
    mode: 'read',
    gate: { action: 'read', subject: 'User' },
    description:
      'List staff members with their role and id — use this to resolve a person\'s name ("Mike") to the user id that assignments and filters need. Any active staff member can be assigned to leads, job crews, and walkthroughs.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name filter' },
      },
      additionalProperties: false,
    },
  },

  get_briefing: {
    name: 'get_briefing',
    capabilityId: 'get_briefing',
    mode: 'read',
    description: 'Get the daily briefing: KPIs, cash, today\'s schedule and what needs attention.',
    parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  create_lead: {
    name: 'create_lead',
    capabilityId: 'create_lead',
    mode: 'write',
    gate: { action: 'create', subject: 'Lead' },
    description:
      'Create a lead. When the user names a customer, call this IMMEDIATELY with customer_name — the tool finds the existing customer for you (no lookup needed first) and will tell you if anything else is missing. Use new_customer (full contact + location) only after the tool says no existing customer matches. Never provide both a customer and new_customer. For an existing customer with multiple service locations pass service_location_id (location ids are in the customer detail), or new_location for a brand-new address. Never invent ids.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        customer_name: {
          type: 'string',
          description: "The customer's name exactly as the user said it — the tool resolves the existing customer automatically",
        },
        customer_id: { type: 'string', description: 'Existing customer id (only when already known from a tool result)' },
        new_customer: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            company_name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
            ad_source: { type: 'string' },
            location: locationSchema,
          },
          required: ['first_name'],
          additionalProperties: false,
        },
        service_location_id: {
          type: 'string',
          description: 'Which of the existing customer\'s service locations (location_id from the customer detail) — important when they have more than one',
        },
        new_location: { ...locationSchema, description: 'A NEW service address for an existing customer' },
        service_request: { type: 'string', description: 'What work the customer needs — ask the user, never invent it' },
        notes: { type: 'string' },
        override: {
          type: 'boolean',
          description: 'Set ONLY after the user was told about a duplicate-customer match and explicitly chose to create a duplicate anyway (this is audited)',
        },
      },
      additionalProperties: false,
    },
  },

  schedule_walkthrough: {
    name: 'schedule_walkthrough',
    capabilityId: 'schedule_walkthrough',
    mode: 'write',
    gate: { action: 'schedule_walkthrough', subject: 'Lead' },
    description:
      'Schedule, move or unschedule a lead\'s walkthrough visit - allowed from any lead status, including NEW (scheduling on a NEW lead automatically advances it to CONTACTED; every other status is left as-is). performer_ids REPLACE the current performer set and may be admins, sales or technicians - never dispatchers (ids from list_users). The customer is emailed unless send_email=false; an empty performer list suppresses the customer email. Schedule conflicts are reported - only set force after the user accepts.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        action: { type: 'string', enum: ['schedule', 'unschedule'] },
        walkthrough_scheduled_at: { type: 'string', description: 'REQUIRED for action=schedule — ISO date-time with offset' },
        performer_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=schedule: the FULL new performer set (REPLACE — anyone not listed is removed; [] = nobody assigned yet)',
        },
        walkthrough_duration_minutes: { type: 'number', description: '15–480, default 60' },
        send_email: { type: 'boolean', description: 'default true' },
        force: { type: 'boolean', description: 'Set ONLY after the user explicitly accepts a reported schedule conflict' },
      },
      required: ['lead_id', 'action'],
      additionalProperties: false,
    },
  },

  create_estimate: {
    name: 'create_estimate',
    capabilityId: 'create_estimate',
    mode: 'write',
    gate: { action: 'create', subject: 'Estimate' },
    description:
      'Create an estimate for an existing, non-terminal lead. Requires the lead_id and at least one line item.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string' },
        scope_notes: { type: 'string' },
        tax_rate: { type: 'number', description: '0–1 (e.g. 0.0825). Omit to auto-derive.' },
        discount_type: { type: 'string', enum: ['PERCENTAGE', 'FIXED_AMOUNT'], description: 'Estimate-level discount' },
        discount_value: { type: 'number' },
        discount_name: { type: 'string' },
        line_items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              unit_cost: { type: 'number' },
              is_taxable: { type: 'boolean' },
              item_type: { type: 'string', enum: ['SERVICE', 'MATERIAL'] },
              price_book_item_id: { type: 'string', description: 'Optional price-book item id' },
              discount_type: { type: 'string', enum: ['PERCENTAGE', 'FIXED_AMOUNT'] },
              discount_value: { type: 'number' },
            },
            required: ['description', 'quantity', 'unit_price'],
            additionalProperties: false,
          },
        },
      },
      required: ['lead_id', 'line_items'],
      additionalProperties: false,
    },
  },

  create_job: {
    name: 'create_job',
    capabilityId: 'create_job',
    mode: 'write',
    gate: { action: 'create', subject: 'Job' },
    description:
      'Create a job EITHER from an approved estimate (estimate_id) OR standalone (BOTH customer_id AND service_location_id — location ids are in the customer detail). The job is created UNSCHEDULED; schedule it and set the crew afterwards with update_job_status action=assign.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        estimate_id: { type: 'string' },
        customer_id: { type: 'string' },
        service_location_id: { type: 'string' },
        scope_notes: { type: 'string' },
        scheduled_start: { type: 'string', description: 'ISO date-time with offset' },
        scheduled_end: { type: 'string', description: 'ISO date-time with offset' },
      },
      required: [],
      additionalProperties: false,
    },
  },

  create_invoice: {
    name: 'create_invoice',
    capabilityId: 'create_invoice',
    mode: 'write',
    gate: { action: 'create', subject: 'Invoice' },
    description:
      'Create an invoice for a job (job_id only). The invoice bills the job\'s Items tab (all its line items), so the job must have at least one item. Servy cannot create a standalone (customer-anchored) invoice or a partial/progress invoice. Service-plan visit jobs are NON-BILLABLE (the plan was paid upfront) - never invoice them. If the job already has an active invoice the API refuses; the existing invoice must be voided first (Servy cannot void).',
    parametersJsonSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },

  update_job_status: {
    name: 'update_job_status',
    capabilityId: 'update_job_status',
    mode: 'write',
    gate: { action: 'update', subject: 'Job' },
    description:
      'Change a job\'s status: assign (schedule + set crew), unassign, start, complete, cancel, reopen, en_route, arrive.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        action: {
          type: 'string',
          enum: ['assign', 'unassign', 'start', 'complete', 'cancel', 'reopen', 'en_route', 'arrive'],
        },
        assignee_ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'action=assign: the FULL new crew of user ids (REPLACE semantics — anyone not listed is removed; [] schedules with no crew; omit to keep the current crew). Ids come from list_users or the job detail.',
        },
        scheduled_start: { type: 'string', description: 'action=assign: ISO date-time with offset. start and end must BOTH be given (unless is_all_day).' },
        scheduled_end: { type: 'string', description: 'action=assign: ISO date-time with offset' },
        is_all_day: { type: 'boolean', description: 'action=assign: all-day job (end optional — defaults to start +24h)' },
        force: { type: 'boolean', description: 'action=assign: set ONLY after the user explicitly accepts a reported schedule conflict' },
        completion_notes: { type: 'string', description: 'For action=complete' },
        cancelled_reason: { type: 'string', description: 'REQUIRED for action=cancel — kept on record; ask the user for it' },
      },
      required: ['job_id', 'action'],
      additionalProperties: false,
    },
  },

  reschedule_job: {
    name: 'reschedule_job',
    capabilityId: 'reschedule_job',
    mode: 'write',
    gate: { action: 'update', subject: 'Job' },
    description:
      'Move a scheduled job to a new date/time. Keeps the current crew, runs schedule-conflict checks, and emails the customer about the new time.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        scheduled_start: { type: 'string', description: 'ISO date-time with offset' },
        scheduled_end: { type: 'string', description: 'ISO date-time with offset' },
      },
      required: ['job_id', 'scheduled_start', 'scheduled_end'],
      additionalProperties: false,
    },
  },

  update_estimate_status: {
    name: 'update_estimate_status',
    capabilityId: 'update_estimate_status',
    mode: 'write',
    gate: { action: 'update', subject: 'Estimate' },
    description:
      'Send an estimate to the customer (emails them IMMEDIATELY), or cancel it. Sending needs an explicit deposit decision from the user. Lifecycle: send works on DRAFT or SENT (resend); cancel on DRAFT/SENT/PENDING; WON estimates are frozen.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        estimate_id: { type: 'string' },
        action: { type: 'string', enum: ['send', 'cancel'] },
        deposit_required: {
          type: 'boolean',
          description: 'REQUIRED for action=send — ask the user whether to require a deposit (the org default is YES, at the org\'s deposit percentage)',
        },
        payment_methods: {
          type: 'array',
          items: { type: 'string', enum: ['CARD', 'EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH', 'ZELLE', 'VENMO', 'CASH_APP', 'OTHER'] },
          description: 'REQUIRED when deposit_required is true — which methods the customer may pay the deposit with',
        },
        cancelled_reason: { type: 'string', description: 'REQUIRED for action=cancel — kept on record; ask the user for it' },
      },
      required: ['estimate_id', 'action'],
      additionalProperties: false,
    },
  },

  add_note: {
    name: 'add_note',
    capabilityId: 'add_note',
    mode: 'write',
    // Intentionally NOT statically gated: a note inherits the *target entity's*
    // update permission, which varies by entity (a technician can note their job
    // but not a lead). There is no single CASL subject for it, so the per-entity
    // /notes endpoint is the gate — the handler surfaces a 403 as a friendly
    // "you don't have permission" message. This is the one cross-entity write.
    description: 'Attach a note to a lead, customer, job, estimate or invoice.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        entity_type: { type: 'string', enum: ['lead', 'customer', 'job', 'estimate', 'invoice'] },
        entity_id: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['entity_type', 'entity_id', 'content'],
      additionalProperties: false,
    },
  },

  create_customer: {
    name: 'create_customer',
    capabilityId: 'create_customer',
    mode: 'write',
    gate: { action: 'create', subject: 'Customer' },
    description:
      'Create a customer. Needs EITHER a first name OR a company_name, plus at least one of phone or email; the rest are optional. If a customer with the same email or phone already exists the API flags the duplicate — never override without the user\'s explicit choice.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        company_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        ad_source: { type: 'string' },
        locations: { type: 'array', items: locationSchema },
        override: {
          type: 'boolean',
          description: 'Set ONLY after the user was told about the duplicate match and explicitly chose to create a duplicate anyway (this is audited)',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },

  update_customer: {
    name: 'update_customer',
    capabilityId: 'update_customer',
    mode: 'write',
    gate: { action: 'update', subject: 'Customer' },
    description: 'Update fields on an existing customer.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        customer_id: { type: 'string' },
        first_name: { type: 'string' },
        last_name: { type: 'string' },
        company_name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        ad_source: { type: 'string' },
      },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },

  draft_message: {
    name: 'draft_message',
    capabilityId: 'draft_message',
    mode: 'draft',
    description:
      'Draft a customer / technician / reminder message for the user to review and send MANUALLY. Servy can never send it. Put the full drafted text in `body`.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Who it is for (e.g. the customer name)' },
        purpose: { type: 'string' },
        body: { type: 'string', description: 'The full message text you drafted' },
      },
      required: ['body'],
      additionalProperties: false,
    },
  },
};

export interface FunctionDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

/**
 * The function declarations the given user is allowed to use (writes pre-gated
 * by CASL). Shaped for the text `generateContent` API — no `behavior` field
 * (that is Bidi/Live-only). Execution is gated again server-side at /api/*.
 */
export function buildFunctionDeclarations(ability: AppAbility): FunctionDeclaration[] {
  return Object.values(TOOL_SPECS)
    .filter((spec) => !spec.gate || ability.can(spec.gate.action, spec.gate.subject))
    .map((spec) => ({
      name: spec.name,
      description: spec.description,
      parametersJsonSchema: spec.parametersJsonSchema,
    }));
}
