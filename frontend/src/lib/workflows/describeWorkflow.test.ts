import { describe, it, expect } from 'vitest';
import { describeWorkflow, formatOffset, templateToWorkflowBody } from './describeWorkflow';
import type { AutomationTemplate, WorkflowCatalog } from '@/lib/api/workflows';

/** Minimal catalog fixture — only the fields describeWorkflow actually reads. */
const CATALOG = {
  triggers: {
    // A label for the "malformed date-anchor config" fallback test below —
    // every other trigger in this file deliberately has NO catalog entry
    // (falls back to EVENT_PHRASES or the raw trigger_type), matching how
    // sparsely the rest of this fixture is populated.
    JOB_DATE_ANCHORED: { label: 'Before or after the appointment' },
  },
  actions: {},
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
    lead: [{ key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough' }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    estimate: [{ key: 'estimate.valid_until', label: 'the estimate expiration' }],
    task: [{ key: 'task.due_at', label: 'the task due date' }],
  },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: {
    conditions: {},
    labels: {
      invoice_paid: 'the invoice is paid',
      job_completed: 'the job was completed',
    },
  },
} as unknown as WorkflowCatalog;

describe('formatOffset', () => {
  it('renders whole days as "N days" (day-first, matching the legacy convention)', () => {
    expect(formatOffset(24 * 60)).toBe('1 day');
    expect(formatOffset(3 * 24 * 60)).toBe('3 days');
  });

  it('renders non-day-aligned spans in hours', () => {
    expect(formatOffset(12 * 60)).toBe('12 hours');
    expect(formatOffset(60)).toBe('1 hour');
  });

  it('renders sub-hour spans in minutes', () => {
    expect(formatOffset(30)).toBe('30 minutes');
    expect(formatOffset(1)).toBe('1 minute');
  });
});

describe('describeWorkflow', () => {
  it('builds the "When …" clause for an event trigger with no steps', () => {
    expect(describeWorkflow('JOB_COMPLETED', null, [], CATALOG)).toBe('When a job is completed');
  });

  it('builds the offset clause for a timed trigger (BEFORE_JOB_START)', () => {
    const sentence = describeWorkflow('BEFORE_JOB_START', { offset_minutes: 12 * 60 }, [], CATALOG);
    expect(sentence).toBe('12 hours before a job starts');
  });

  it('walks a multi-step chain in order: trigger → wait → send → stop-if', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [
        { step_type: 'WAIT', config: { duration_minutes: 24 * 60 } },
        { step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
        { step_type: 'STOP_IF', config: { condition: 'invoice_paid' } },
      ],
      CATALOG,
    );
    expect(sentence).toBe(
      'When a job is completed → wait 1 day → text the customer → stop if the invoice is paid',
    );
  });

  it('renders the stop-if clause via the catalog label', () => {
    const sentence = describeWorkflow(
      'JOB_CANCELLED',
      null,
      [{ step_type: 'STOP_IF', config: { condition: 'job_completed' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is cancelled → stop if the job was completed');
  });

  it('falls back to the raw condition when the catalog has no label for it', () => {
    const sentence = describeWorkflow(
      'JOB_CANCELLED',
      null,
      [{ step_type: 'STOP_IF', config: { condition: 'unknown_condition' } }],
      undefined,
    );
    expect(sentence).toBe('When a job is cancelled → stop if unknown condition');
  });

  it('describes SEND_EMAIL and SEND_TEXT steps by recipient', () => {
    const sentence = describeWorkflow(
      'INVOICE_PAID',
      null,
      [
        { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Thanks', body: 'hi' } },
        { step_type: 'SEND_TEXT', config: { recipient: 'all_dispatchers', body: 'paid' } },
      ],
      CATALOG,
    );
    expect(sentence).toBe('When an invoice is paid → email the customer → text all dispatchers');
  });

  it('reads the v2.1 recipients array and joins 2 with "and"', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_EMAIL', config: { recipients: ['customer', 'dispatcher'], subject: 'Hi', body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → email the customer and the dispatcher');
  });

  it('still renders a legacy singular config with no recipients array', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Hi', body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → email the customer');
  });

  it('joins 3+ recipients with an Oxford comma', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_TEXT', config: { recipients: ['customer', 'dispatcher', 'salesperson'], body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → text the customer, the dispatcher, and the salesperson');
  });

  it('SEND_TEXT also reads the recipients array (shared clause helper)', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_TEXT', config: { recipients: ['customer', 'dispatcher'], body: 'hi' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → text the customer and the dispatcher');
  });

  it('keeps the legacy assigned_techs label distinct from the new assigned_team', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_TEXT', config: { recipient: 'assigned_techs', body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → text the assigned technician(s)');
  });

  it.each([
    ['assigned_team', 'the assigned team'],
    ['dispatcher', 'the dispatcher'],
    ['salesperson', 'the salesperson'],
    ['creator', 'the creator'],
    // Spec B's two task audiences. Absent from the label map they read as the bare
    // '?? the recipient' fallback, which compiles and passes everything else.
    ['assignees', 'the assignees'],
    ['watchers', 'the watchers'],
  ] as const)('labels the new %s audience key as %s', (key, label) => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'SEND_TEXT', config: { recipients: [key], body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe(`When a job is completed → text ${label}`);
  });

  it('renders an anchored WAIT clause: "wait until <offset> <direction> <anchor label>"', () => {
    const sentence = describeWorkflow(
      'WALKTHROUGH_SCHEDULED',
      null,
      [
        {
          step_type: 'WAIT',
          config: {
            mode: 'anchored',
            anchor: 'lead.walkthrough_scheduled_at',
            direction: 'before',
            offset_minutes: 24 * 60,
          },
        },
      ],
      CATALOG,
    );
    expect(sentence).toBe('When a walkthrough is scheduled → wait until 1 day before the walkthrough');
  });

  it('renders an anchored WAIT clause targeting the job anchor, "after" direction', () => {
    const sentence = describeWorkflow(
      'JOB_SCHEDULED',
      null,
      [
        { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 } },
      ],
      CATALOG,
    );
    expect(sentence).toBe('When a job is scheduled → wait until 1 hour after the appointment');
  });

  it('falls back to the plain "wait" clause when the catalog is undefined (anchor label comes from the catalog now)', () => {
    const sentence = describeWorkflow(
      'JOB_SCHEDULED',
      null,
      [
        { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 } },
      ],
      undefined,
    );
    expect(sentence).toBe('When a job is scheduled → wait');
  });

  it('still renders the plain relative WAIT clause for a legacy (mode-less) config', () => {
    const sentence = describeWorkflow(
      'JOB_COMPLETED',
      null,
      [{ step_type: 'WAIT', config: { duration_minutes: 90 } }],
      CATALOG,
    );
    expect(sentence).toBe('When a job is completed → wait 90 minutes');
  });

  describe('trigger-level date-anchored clause (Part B: JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED)', () => {
    it.each([
      ['JOB_DATE_ANCHORED', { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 }, '1 day before the appointment'],
      ['LEAD_DATE_ANCHORED', { anchor: 'lead.walkthrough_scheduled_at', direction: 'after', offset_minutes: 60 }, '1 hour after the walkthrough'],
      ['INVOICE_DATE_ANCHORED', { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 4320 }, '3 days before the invoice due date'],
      ['ESTIMATE_DATE_ANCHORED', { anchor: 'estimate.valid_until', direction: 'after', offset_minutes: 30 }, '30 minutes after the estimate expiration'],
      // Spec B slice 5, and BOTH directions from the one trigger. Missing from this file's own
      // hand-written DATE_ANCHORED_TRIGGERS set, a task reminder's recipe sentence degrades to
      // "When task_date_anchored" - the raw enum value, in the admin's list of automations.
      ['TASK_DATE_ANCHORED', { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 }, '1 day before the task due date'],
      ['TASK_DATE_ANCHORED', { anchor: 'task.due_at', direction: 'after', offset_minutes: 4320 }, '3 days after the task due date'],
    ] as const)('renders "%s" as "%s before/after {anchor label}", no "When" prefix (offset-first, like the legacy timed triggers)', (trigger, config, expected) => {
      expect(describeWorkflow(trigger, config, [], CATALOG)).toBe(expected);
    });

    it('does NOT use TriggerReadback\'s 0/1-day special phrasing ("Just before"/"The day before") — plain formatOffset, matching every other trigger clause in this file', () => {
      expect(
        describeWorkflow('JOB_DATE_ANCHORED', { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 }, [], CATALOG),
      ).toBe('1 day before the appointment');
      // formatOffset(0) buckets into "days" (0 is divisible by everything) — not TriggerReadback's "Just before".
      expect(
        describeWorkflow('JOB_DATE_ANCHORED', { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 0 }, [], CATALOG),
      ).toBe('0 days before the appointment');
    });

    it('walks a full recipe: date-anchored trigger → step, no "When" prefix on the trigger clause', () => {
      const sentence = describeWorkflow(
        'INVOICE_DATE_ANCHORED',
        { anchor: 'invoice.due_date', direction: 'after', offset_minutes: 4320 },
        [{ step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: '', body: 'hi' } }],
        CATALOG,
      );
      expect(sentence).toBe('3 days after the invoice due date → email the customer');
    });

    it('walks a full task recipe: reminder trigger → email the assignees', () => {
      const sentence = describeWorkflow(
        'TASK_DATE_ANCHORED',
        { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
        [{ step_type: 'SEND_EMAIL', config: { recipients: ['assignees'], subject: 's', body: 'hi' } }],
        CATALOG,
      );
      expect(sentence).toBe('1 day before the task due date → email the assignees');
    });

    it('falls back to the catalog label when trigger_config is malformed (missing anchor/direction) — never crashes', () => {
      const sentence = describeWorkflow('JOB_DATE_ANCHORED', { offset_minutes: 1440 }, [], CATALOG);
      expect(sentence).toBe('When before or after the appointment');
    });

    it('falls back to the raw trigger_type when the catalog is undefined (anchor label comes from the catalog now, matching the anchored-WAIT precedent above)', () => {
      const sentence = describeWorkflow(
        'ESTIMATE_DATE_ANCHORED',
        { anchor: 'estimate.valid_until', direction: 'before', offset_minutes: 1440 },
        [],
        undefined,
      );
      expect(sentence).toBe('When ESTIMATE_DATE_ANCHORED');
    });

    it('falls back gracefully when the config anchor is not in the catalog\'s anchors at all', () => {
      const sentence = describeWorkflow(
        'JOB_DATE_ANCHORED',
        { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 60 } as never,
        [],
        { ...CATALOG, anchors: {} } as unknown as WorkflowCatalog,
      );
      expect(sentence).toBe('When before or after the appointment');
    });
  });

  it.each([
    ['LEAD_ASSIGNED', 'When a lead is assigned'],
    ['WALKTHROUGH_SCHEDULED', 'When a walkthrough is scheduled'],
    ['WALKTHROUGH_RESCHEDULED', 'When a walkthrough is rescheduled'],
    ['WALKTHROUGH_COMPLETED', 'When a walkthrough is completed'],
    ['WALKTHROUGH_CANCELLED', 'When a walkthrough is cancelled'],
    ['WALKTHROUGH_PERFORMER_ASSIGNED', 'When a walkthrough performer is assigned'],
    // The hard-coded → Automation Center migration's new triggers.
    ['JOB_EN_ROUTE', 'When a technician is on the way'],
    ['TECH_UNASSIGNED', 'When a technician is unassigned'],
    ['WALKTHROUGH_PERFORMER_REMOVED', 'When a walkthrough performer is removed'],
  ] as const)('renders the EVENT_PHRASES entry for %s', (trigger, expected) => {
    expect(describeWorkflow(trigger, null, [], CATALOG)).toBe(expected);
  });

  it('describes a removed_user recipient by its plain-English label', () => {
    const sentence = describeWorkflow(
      'TECH_UNASSIGNED',
      null,
      [{ step_type: 'SEND_EMAIL', config: { recipient: 'removed_user', subject: 'Bye', body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a technician is unassigned → email the removed team member');
  });

  it('describes an assigned_user recipient by its plain-English label', () => {
    const sentence = describeWorkflow(
      'TECH_ASSIGNED',
      null,
      [{ step_type: 'SEND_EMAIL', config: { recipient: 'assigned_user', subject: 'Hi', body: 'x' } }],
      CATALOG,
    );
    expect(sentence).toBe('When a technician is assigned → email the assigned team member');
  });
});

describe('templateToWorkflowBody', () => {
  const smsTemplate: AutomationTemplate = {
    key: 'reminder-24h',
    name: '24-hour appointment reminder',
    description: 'Text the customer one day before their scheduled job.',
    category: 'customer',
    trigger_type: 'BEFORE_JOB_START',
    trigger_config: { offset_minutes: 24 * 60 },
    action_type: 'SEND_SMS',
    action_config: { recipient: 'customer', body: 'Hi {{customer.first_name}}' },
    send_window: 'BUSINESS_HOURS',
  };

  it('maps SEND_SMS → SEND_TEXT and folds the action into a single step', () => {
    const body = templateToWorkflowBody(smsTemplate);
    expect(body).toMatchObject({
      name: '24-hour appointment reminder',
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 24 * 60 },
      template_key: 'reminder-24h',
      steps: [{ step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'Hi {{customer.first_name}}' } }],
    });
  });

  it('never carries the template send_window onto the new workflow', () => {
    // The fixture is BUSINESS_HOURS on purpose: seeding from a recipe must not
    // mint an automation with a deferral rule the builder can no longer show.
    expect(smsTemplate.send_window).toBe('BUSINESS_HOURS');
    expect(templateToWorkflowBody(smsTemplate)).not.toHaveProperty('send_window');
  });

  it('never leaks a subject key onto a SEND_TEXT step config', () => {
    const body = templateToWorkflowBody(smsTemplate);
    expect(body.steps?.[0]?.config).not.toHaveProperty('subject');
  });

  it('maps SEND_EMAIL → SEND_EMAIL and keeps the subject', () => {
    const emailTemplate: AutomationTemplate = {
      key: 'payment-thank-you',
      name: 'Payment thank-you',
      description: 'Thank the customer when paid.',
      category: 'money',
      trigger_type: 'INVOICE_PAID',
      action_type: 'SEND_EMAIL',
      action_config: { recipient: 'customer', subject: 'Thank you!', body: 'Thanks for paying.' },
      send_window: 'ANYTIME',
    };
    const body = templateToWorkflowBody(emailTemplate);
    expect(body.steps).toEqual([
      { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Thank you!', body: 'Thanks for paying.' } },
    ]);
    expect(body.trigger_config ?? null).toBeNull();
  });

  it('installs no step for an action with no authorable step type', () => {
    // The five in-app gallery entries are gone and `action_type` is now the
    // authorable union, so this template cannot be WRITTEN any more - hence the
    // cast. The guard it exercises is still load-bearing, because the catalog is
    // fetched JSON: a server on an older build, or a response cached before the
    // retirement, can still hand this page a template the type says is
    // impossible. "Use this" must fold it to nothing rather than mint a step the
    // write API now rejects with a 400.
    const teamTemplate = {
      key: 'new-lead-alert',
      name: 'New lead alert',
      description: 'Ping the office.',
      category: 'team',
      trigger_type: 'LEAD_CREATED',
      action_type: 'NOTIFY_TEAM',
      action_config: { recipient: 'all_dispatchers', body: 'New lead.' },
      send_window: 'ANYTIME',
    } as unknown as AutomationTemplate;
    expect(templateToWorkflowBody(teamTemplate).steps).toEqual([]);
  });

  it('uses an explicit multi-step template verbatim instead of folding action_config', () => {
    const reminderTemplate: AutomationTemplate = {
      key: 'walkthrough-reminder-1d',
      name: 'Walkthrough reminder (1 day before)',
      description: 'Email the customer a reminder the day before their walkthrough.',
      category: 'customer',
      trigger_type: 'WALKTHROUGH_SCHEDULED',
      action_type: 'SEND_EMAIL',
      action_config: {
        recipient: 'customer',
        subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow',
        body: 'Hi {{customer.first_name}}, reminder!',
      },
      steps: [
        {
          step_type: 'WAIT',
          config: {
            mode: 'anchored',
            anchor: 'lead.walkthrough_scheduled_at',
            direction: 'before',
            offset_minutes: 1440,
          },
        },
        {
          step_type: 'SEND_EMAIL',
          config: {
            recipient: 'customer',
            subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow',
            body: 'Hi {{customer.first_name}}, reminder!',
          },
        },
      ],
      send_window: 'BUSINESS_HOURS',
    };
    const body = templateToWorkflowBody(reminderTemplate);
    expect(body.steps).toEqual([
      {
        step_type: 'WAIT',
        config: {
          mode: 'anchored',
          anchor: 'lead.walkthrough_scheduled_at',
          direction: 'before',
          offset_minutes: 1440,
        },
      },
      {
        step_type: 'SEND_EMAIL',
        config: {
          recipient: 'customer',
          subject: 'Reminder: your walkthrough with {{org.name}} is tomorrow',
          body: 'Hi {{customer.first_name}}, reminder!',
        },
      },
    ]);
  });

  it('a timed follow-up template stays single-step (no auto-inserted stop-if)', () => {
    const followUp: AutomationTemplate = {
      key: 'estimate-follow-up-3d',
      name: 'Estimate follow-up (3 days)',
      description: 'Nudge unresponsive customers.',
      category: 'customer',
      trigger_type: 'ESTIMATE_FOLLOW_UP',
      trigger_config: { offset_minutes: 3 * 24 * 60 },
      action_type: 'SEND_EMAIL',
      action_config: { recipient: 'customer', subject: 'Still there?', body: 'Following up.' },
      send_window: 'BUSINESS_HOURS',
    };
    const body = templateToWorkflowBody(followUp);
    expect(body.steps).toHaveLength(1);
  });
});
