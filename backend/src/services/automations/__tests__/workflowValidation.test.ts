import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '../catalog';
import {
  STOP_IF_CONDITIONS,
  STOP_IF_LABELS,
  waitConfigSchema,
  sendTextConfigSchema,
  sendEmailConfigSchema,
  notifyTeamConfigSchema,
  stopIfConfigSchema,
  subStatusTriggerConfigSchema,
  validateWorkflowDefinition,
  isSupportedStepType,
  AUTHORABLE_STEP_TYPES,
  UNSUPPORTED_STEP_MESSAGE,
  retiredInAppStepMessage,
  type WorkflowStepInput,
} from '../workflowValidation';

// ── step fixtures ────────────────────────────────────────────────────────────

const waitStep = (position: number, duration = 60): WorkflowStepInput => ({
  position,
  step_type: 'WAIT',
  config: { duration_minutes: duration },
});

const sendTextStep = (
  position: number,
  overrides: Partial<{ recipient: string; body: string }> = {},
): WorkflowStepInput => ({
  position,
  step_type: 'SEND_TEXT',
  config: { recipient: 'customer', body: 'Hi {{customer.first_name}}', ...overrides },
});

const sendEmailStep = (
  position: number,
  overrides: Partial<{ recipient: string; subject: string; body: string; custom_email: string }> = {},
): WorkflowStepInput => ({
  position,
  step_type: 'SEND_EMAIL',
  config: {
    recipient: 'customer',
    subject: 'Hello',
    body: 'Hi {{customer.first_name}}',
    ...overrides,
  },
});

const stopIfStep = (position: number, condition: string): WorkflowStepInput => ({
  position,
  step_type: 'STOP_IF',
  config: { condition },
});

// ── per-step config schemas ─────────────────────────────────────────────────

describe('waitConfigSchema', () => {
  it('rejects below the 5-minute floor', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 4 }).success).toBe(false);
  });

  it('accepts the 5-minute floor', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5 }).success).toBe(true);
  });

  it('accepts the 129600-minute ceiling (90 days)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129600 }).success).toBe(true);
  });

  it('rejects above the 129600-minute ceiling', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129601 }).success).toBe(false);
  });

  it('rejects non-integer durations', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 60.5 }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 60, extra: true }).success).toBe(false);
  });
});

describe('sendTextConfigSchema', () => {
  it('accepts a valid customer text', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'Hi there' }).success).toBe(true);
  });

  // Spec C slice 1 replaced the "rejects a non-customer recipient" assertion that stood
  // here. The text config's recipients used to be an array of the literal 'customer'; they
  // are now the same twelve AUDIENCE_KEYS the notify-team config already spoke, so the
  // schema stops being the first of the two doors that shut a staff text out. Every key but
  // `customer` and `specific_user` is exercised here; those two have their own assertions.
  it('accepts every staff audience the shared audience-key set carries', () => {
    for (const key of [
      'assigned_team',
      'dispatcher',
      'salesperson',
      'creator',
      'all_admins',
      'all_dispatchers',
      'removed_user',
      'assigned_user',
      'assignees',
      'watchers',
    ]) {
      expect(sendTextConfigSchema.safeParse({ recipients: [key], body: 'Hi' }).success, key).toBe(true);
    }
  });

  it('accepts a mixed customer-and-staff audience', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: ['customer', 'assigned_team'], body: 'Hi' }).success).toBe(
      true,
    );
  });

  it('accepts a named team member with their id', () => {
    expect(
      sendTextConfigSchema.safeParse({
        recipients: ['specific_user'],
        user_ids: ['11111111-1111-4111-8111-111111111111'],
        body: 'Hi',
      }).success,
    ).toBe(true);
  });

  it('rejects a user id that is not a uuid', () => {
    expect(
      sendTextConfigSchema.safeParse({ recipients: ['specific_user'], user_ids: ['nope'], body: 'Hi' }).success,
    ).toBe(false);
  });

  // `custom` is an audience of literal email ADDRESSES. There is nothing on a handset for it
  // to resolve to, so it stays email-only - which is why the element enum here is
  // textRecipientKey (AUDIENCE_KEYS) and not emailRecipientKey (AUDIENCE_KEYS + custom).
  it('rejects the custom-email audience, which has no meaning on a text', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: ['custom'], body: 'Hi' }).success).toBe(false);
  });

  // .strict() is what enforces the line above: without it a text step could carry addresses
  // it can never deliver to, and the custom ⇔ custom_emails cross-check is SEND_EMAIL-only.
  it('rejects a custom_emails field on a text step', () => {
    expect(
      sendTextConfigSchema.safeParse({ recipients: ['customer'], custom_emails: ['a@b.com'], body: 'Hi' }).success,
    ).toBe(false);
  });

  it('rejects an unknown recipient key', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'the_mailman', body: 'Hi' }).success).toBe(false);
  });

  it('still folds a legacy singular recipient into the array', () => {
    const parsed = sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'Hi' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ recipients: ['customer'] });
  });

  it('still folds the legacy assigned_techs alias to assigned_team', () => {
    const parsed = sendTextConfigSchema.safeParse({ recipient: 'assigned_techs', body: 'Hi' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ recipients: ['assigned_team'] });
  });

  it('rejects a body over 320 characters', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'x'.repeat(321) }).success).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: '' }).success).toBe(false);
  });
});

describe('sendEmailConfigSchema', () => {
  it('accepts a valid email config', () => {
    expect(
      sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Hello' }).success,
    ).toBe(true);
  });

  it('accepts custom recipient with a valid custom_email', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipient: 'custom',
        subject: 'Hi',
        body: 'Hello',
        custom_email: 'a@b.com',
      }).success,
    ).toBe(true);
  });

  it('rejects a malformed custom_email', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipient: 'custom',
        subject: 'Hi',
        body: 'Hello',
        custom_email: 'not-an-email',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty subject', () => {
    expect(sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: '', body: 'Hello' }).success).toBe(
      false,
    );
  });

  it('accepts a specific_user recipient (a team member is a valid email audience in v2.1)', () => {
    expect(
      sendEmailConfigSchema.safeParse({ recipient: 'specific_user', subject: 'Hi', body: 'Hello' }).success,
    ).toBe(true);
  });

  it('normalizes the legacy singular { recipient } into recipients: [recipient]', () => {
    const parsed = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Hello' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ recipients: ['customer'] });
  });

  it('accepts a recipients[] array shape directly', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipients: ['customer', 'all_admins'],
        subject: 'Hi',
        body: 'Hello',
      }).success,
    ).toBe(true);
  });

  it('folds the legacy custom_email into custom_emails: [custom_email]', () => {
    const parsed = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Hello',
      custom_email: 'a@b.com',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ custom_emails: ['a@b.com'] });
  });
});

describe('notifyTeamConfigSchema', () => {
  it('accepts a valid notify-team config', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'all_dispatchers', body: 'FYI' }).success).toBe(true);
  });

  it('accepts specific_user with a valid uuid', () => {
    expect(
      notifyTeamConfigSchema.safeParse({
        recipient: 'specific_user',
        body: 'FYI',
        user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      }).success,
    ).toBe(true);
  });

  it('rejects a custom recipient (custom email is a SEND_EMAIL-only audience)', () => {
    expect(notifyTeamConfigSchema.safeParse({ recipient: 'custom', body: 'FYI' }).success).toBe(false);
  });

  it('rejects a non-uuid user_id', () => {
    expect(
      notifyTeamConfigSchema.safeParse({ recipient: 'specific_user', body: 'FYI', user_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('normalizes the legacy singular { user_id } into user_ids: [user_id]', () => {
    const parsed = notifyTeamConfigSchema.safeParse({
      recipient: 'specific_user',
      body: 'FYI',
      user_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'] });
  });

  it('accepts multiple user_ids for a specific_user notify', () => {
    expect(
      notifyTeamConfigSchema.safeParse({
        recipients: ['specific_user'],
        body: 'FYI',
        user_ids: ['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002'],
      }).success,
    ).toBe(true);
  });
});

describe('stopIfConfigSchema', () => {
  it('accepts any non-empty condition string (entity-legality is validateWorkflowDefinition\'s job)', () => {
    expect(stopIfConfigSchema.safeParse({ condition: 'job_cancelled' }).success).toBe(true);
  });

  it('rejects an empty condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: '' }).success).toBe(false);
  });
});

// ── the issues[] an admin actually reads ────────────────────────────────────
//
// validateWorkflowDefinition runs on every READ of a workflow, and the API hands
// the issues straight to the automations list, so a constraint with no copy of
// its own is published to an admin as the validator's own developer English
// ("String must contain at least 1 character(s)" on config.subject). The
// retirement notice sitting on that same page speaks product English; every
// other issue on it has to as well, or the page reads half-finished.
describe('validateWorkflowDefinition - step config issues speak product English', () => {
  const RAW_VALIDATOR_COPY =
    /String must contain|Array must contain|Number must be|Expected integer|Invalid enum value|Invalid literal|Invalid email|Invalid uuid/;

  const issuesFor = (step: WorkflowStepInput) =>
    validateWorkflowDefinition({ trigger_type: 'JOB_SCHEDULED', steps: [step] });

  it('an empty subject asks for a subject line', () => {
    expect(issuesFor(sendEmailStep(0, { subject: '' }))).toContainEqual({
      step_index: 0,
      path: 'config.subject',
      message: 'Add a subject line',
    });
  });

  it('an empty email body asks for the email to be written', () => {
    expect(issuesFor(sendEmailStep(0, { body: '' }))).toContainEqual({
      step_index: 0,
      path: 'config.body',
      message: 'Write the email',
    });
  });

  // Every constraint an admin can actually trip, not just the two above: a body
  // over the cap leaks a raw string exactly as loudly as an empty one does.
  it('no step config constraint leaks the validator\'s own wording', () => {
    const cases: Array<[string, WorkflowStepInput]> = [
      ['wait under the 5-minute floor', waitStep(0, 2)],
      ['wait past the 90-day limit', waitStep(0, 129601)],
      ['a fractional wait', waitStep(0, 60.5)],
      ['an empty text body', sendTextStep(0, { body: '' })],
      ['a text over 320 characters', sendTextStep(0, { body: 'x'.repeat(321) })],
      ['an empty subject', sendEmailStep(0, { subject: '' })],
      ['a subject over 200 characters', sendEmailStep(0, { subject: 'x'.repeat(201) })],
      ['an empty email body', sendEmailStep(0, { body: '' })],
      ['an email over 5000 characters', sendEmailStep(0, { body: 'x'.repeat(5001) })],
      ['a malformed custom email', sendEmailStep(0, { recipient: 'custom', custom_email: 'not-an-email' })],
      [
        'no recipients at all',
        { position: 0, step_type: 'SEND_EMAIL', config: { recipients: [], subject: 'Hi', body: 'Hello' } },
      ],
      [
        'an unrecognisable team member',
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['specific_user'], subject: 'Hi', body: 'Hello', user_ids: ['not-a-uuid'] },
        },
      ],
      ['an empty stop condition', stopIfStep(0, '')],
    ];

    for (const [label, step] of cases) {
      const issues = issuesFor(step);
      expect(issues.length, `${label} should still be refused`).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.message, `${label} is explained to the admin, not quoted at them`).not.toMatch(
          RAW_VALIDATOR_COPY,
        );
        expect(issue.message, `${label} never names an internal label`).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      }
    }
  });
});

// ── STOP_IF_CONDITIONS / STOP_IF_LABELS ─────────────────────────────────────

describe('STOP_IF_CONDITIONS', () => {
  it('lists the legal conditions per entity, with lead empty', () => {
    expect(STOP_IF_CONDITIONS.invoice).toEqual(['invoice_paid', 'invoice_not_open']);
    expect(STOP_IF_CONDITIONS.estimate).toEqual(['estimate_answered', 'estimate_approved', 'estimate_declined']);
    expect(STOP_IF_CONDITIONS.job).toEqual(['job_cancelled', 'job_completed', 'job_rescheduled']);
    expect(STOP_IF_CONDITIONS.lead).toEqual([]);
  });
});

describe('STOP_IF_LABELS', () => {
  it('has a plain-English label for every condition across all entities', () => {
    const all = Object.values(STOP_IF_CONDITIONS).flat();
    for (const condition of all) {
      expect(STOP_IF_LABELS[condition]).toBeTruthy();
    }
  });

  it('matches the exact wording from the design', () => {
    expect(STOP_IF_LABELS.invoice_paid).toBe('the invoice is paid');
    expect(STOP_IF_LABELS.invoice_not_open).toBe('the invoice is no longer open');
    expect(STOP_IF_LABELS.estimate_answered).toBe('the customer answered the estimate');
    expect(STOP_IF_LABELS.estimate_approved).toBe('the estimate was approved');
    expect(STOP_IF_LABELS.estimate_declined).toBe('the estimate was declined');
    expect(STOP_IF_LABELS.job_cancelled).toBe('the job was cancelled');
    expect(STOP_IF_LABELS.job_completed).toBe('the job was completed');
    expect(STOP_IF_LABELS.job_rescheduled).toBe('the job was rescheduled');
  });
});

// ── validateWorkflowDefinition ───────────────────────────────────────────────

describe('validateWorkflowDefinition — happy path', () => {
  it('returns [] for a fully valid multi-step definition', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [waitStep(0), sendEmailStep(1), stopIfStep(2, 'job_cancelled'), sendTextStep(3)],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 1: timed trigger requires offset', () => {
  it('flags a timed trigger with no trigger_config', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger needs a timing offset (e.g. 24 hours before)',
    });
  });

  it('flags a timed trigger whose offset is out of bounds', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 129601 },
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger needs a timing offset (e.g. 24 hours before)',
    });
  });

  it('passes a timed trigger with a valid offset', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'BEFORE_JOB_START',
      trigger_config: { offset_minutes: 1440 },
      steps: [sendTextStep(0)],
    });
    expect(issues.filter((i) => i.path === 'trigger_config')).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 2: event trigger rejects an offset', () => {
  it('flags an event trigger carrying a trigger_config', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: { offset_minutes: 60 },
      steps: [sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  });
});

describe('validateWorkflowDefinition — rule 3: steps must be non-empty', () => {
  it('flags an empty steps array', () => {
    const issues = validateWorkflowDefinition({ trigger_type: 'JOB_SCHEDULED', steps: [] });
    expect(issues).toEqual([{ step_index: -1, path: 'steps', message: 'Add at least one step' }]);
  });
});

describe('validateWorkflowDefinition — rule 4: positions must be 0..n-1 ascending', () => {
  it('flags a gap in positions', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), sendTextStep(2)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'steps',
      message: 'Steps are out of order — tidy up and try again',
    });
  });

  it('flags steps presented out of ascending order', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(1), sendTextStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'steps',
      message: 'Steps are out of order — tidy up and try again',
    });
  });

  it('passes contiguous ascending positions starting at 0', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), sendTextStep(1)],
    });
    expect(issues.filter((i) => i.message.includes('out of order'))).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 5: per-step config must parse', () => {
  // waitConfigSchema routes through z.preprocess + z.discriminatedUnion('mode', …):
  // a no-`mode`-key config is defaulted to mode:'relative' before the union picks
  // a branch, so an invalid legacy WAIT config still reports a field-scoped
  // config.duration_minutes path instead of a path-less invalid_union issue.
  it('surfaces the zod message with a config.<field> path and the step array index', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0), waitStep(1, 2)],
    });
    const issue = issues.find((i) => i.path.startsWith('config.duration_minutes'));
    expect(issue).toBeDefined();
    expect(issue?.step_index).toBe(1);
    expect(issue?.message.length).toBeGreaterThan(0);
  });
});

describe('validateWorkflowDefinition — rule 6: every recipient must be legal for the trigger entity', () => {
  it('flags a key not in the entity audience (dispatcher on a lead trigger)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [sendEmailStep(0, { recipient: 'dispatcher' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "dispatcher" is not available for this trigger',
    });
  });

  it('allows assigned_team on a job trigger (the assigned crew)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'assigned_team' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('allows the walkthrough team (assigned_team) on a lead trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [sendEmailStep(0, { recipient: 'assigned_team' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('folds the legacy assigned_techs alias to assigned_team (legal on a job)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'assigned_techs' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  // removed_user is trigger-specific (catalog.ts's REMOVED_RECIPIENT_TRIGGERS),
  // not entity-wide like every other audience — this is the case that forced
  // rule 6 off audiencesForEntity(entity) and onto the trigger-aware
  // audiencesFor(trigger, action) the catalog's own multi-select already uses,
  // so the builder and the validator can never legalize different sets.
  it('allows removed_user on TECH_UNASSIGNED but flags it on TECH_ASSIGNED (same entity, wrong trigger)', () => {
    const legal = validateWorkflowDefinition({
      trigger_type: 'TECH_UNASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'removed_user' })],
    });
    expect(legal.filter((i) => i.path === 'config.recipients')).toEqual([]);

    const illegal = validateWorkflowDefinition({
      trigger_type: 'TECH_ASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'removed_user' })],
    });
    expect(illegal).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "removed_user" is not available for this trigger',
    });
  });

  it('allows removed_user on WALKTHROUGH_PERFORMER_REMOVED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_PERFORMER_REMOVED',
      steps: [sendEmailStep(0, { recipient: 'removed_user' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  // Mirror of the removed_user case above, for the opposite direction: the
  // audience that must be "the one person just added", not the live crew.
  it('allows assigned_user on TECH_ASSIGNED but flags it on TECH_UNASSIGNED (same entity, wrong trigger)', () => {
    const legal = validateWorkflowDefinition({
      trigger_type: 'TECH_ASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'assigned_user' })],
    });
    expect(legal.filter((i) => i.path === 'config.recipients')).toEqual([]);

    const illegal = validateWorkflowDefinition({
      trigger_type: 'TECH_UNASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'assigned_user' })],
    });
    expect(illegal).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "assigned_user" is not available for this trigger',
    });
  });

  it('allows assigned_user on WALKTHROUGH_PERFORMER_ASSIGNED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_PERFORMER_ASSIGNED',
      steps: [sendEmailStep(0, { recipient: 'assigned_user' })],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('flags an illegal key inside a multi-key recipients[] array', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'ESTIMATE_APPROVED',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['all_admins', 'dispatcher'], subject: 'Hi', body: 'FYI' },
        },
      ],
    });
    // dispatcher is not an estimate audience; all_admins is fine
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "dispatcher" is not available for this trigger',
    });
    expect(issues.filter((i) => i.message.includes('all_admins'))).toEqual([]);
  });

  it('allows custom for SEND_EMAIL', () => {
    const emailOk = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom', custom_email: 'a@b.com' })],
    });
    expect(emailOk.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });
});

// ── Spec C slice 1: a text step addressed to staff publishes ─────────────────
//
// The tracer bullet. A staff-addressed text used to be refused TWICE on this one request -
// by sendTextConfigSchema (recipients typed as the literal 'customer') and again by the
// legality check below it, which reads audiencesFor() and found only `customer` legal for a
// text. Both doors are on the same request path, so these assertions are what prove the
// pair moved together: widening either one alone still leaves the publish rejected.

describe('validateWorkflowDefinition - Spec C: a text step addressed to staff publishes', () => {
  const staffText = (position: number, config: Record<string, unknown>): WorkflowStepInput => ({
    position,
    step_type: 'SEND_TEXT',
    config,
  });

  it('accepts a text step addressed to the assigned crew, and reads back with those recipients', () => {
    const step = staffText(0, { recipients: ['assigned_team'], body: 'You are on job {{job.number}}' });
    expect(
      validateWorkflowDefinition({ trigger_type: 'JOB_SCHEDULED', trigger_config: null, steps: [step] }),
    ).toEqual([]);

    // The readback half. validateWorkflowDefinition runs on every READ of a workflow
    // (toApiWorkflow), re-parsing the stored config through the same schema, so a narrowing
    // left in place here would drop the audience on the way OUT rather than at publish -
    // silently, and only for workflows that had already been saved.
    const parsed = sendTextConfigSchema.safeParse(step.config);
    expect(parsed.success && parsed.data).toMatchObject({ recipients: ['assigned_team'] });
  });

  it('accepts a text step addressed to the walkthrough team on a lead trigger', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'WALKTHROUGH_SCHEDULED',
        trigger_config: null,
        steps: [staffText(0, { recipients: ['assigned_team'], body: 'Walkthrough booked' })],
      }),
    ).toEqual([]);
  });

  it('accepts a text step addressed to the technician just assigned', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TECH_ASSIGNED',
        trigger_config: null,
        steps: [staffText(0, { recipients: ['assigned_user'], body: 'Job {{job.number}} is yours' })],
      }),
    ).toEqual([]);
  });

  it('accepts a text step addressed to the technician just removed', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TECH_UNASSIGNED',
        trigger_config: null,
        steps: [staffText(0, { recipients: ['removed_user'], body: 'You are off job {{job.number}}' })],
      }),
    ).toEqual([]);
  });

  it('accepts a named team member together with their id', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'JOB_SCHEDULED',
        trigger_config: null,
        steps: [
          staffText(0, {
            recipients: ['specific_user'],
            user_ids: ['11111111-1111-4111-8111-111111111111'],
            body: 'Heads up',
          }),
        ],
      }),
    ).toEqual([]);
  });

  // The cross-check that comes for free. It runs for EVERY messaging step with no action
  // gate, so allowing `user_ids` through the text schema is the whole of what makes it
  // apply here - there is no second edit down in validateStep.
  it('refuses a named team member with no id, in the words the email step already uses', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [staffText(0, { recipients: ['specific_user'], body: 'Heads up' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.user_ids',
      message: 'Pick the team member to notify',
    });
  });

  it('refuses ids with no named-member recipient, the other direction of the same rule', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [
        staffText(0, {
          recipients: ['assigned_team'],
          user_ids: ['11111111-1111-4111-8111-111111111111'],
          body: 'Heads up',
        }),
      ],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.user_ids',
      message: 'Add the specific-person recipient, or remove the chosen team member(s)',
    });
  });

  // The per-entity narrowing is untouched by Spec C and still does its job on the text
  // channel: an invoice has no dispatcher, so the audience is illegal there whichever
  // channel asks for it.
  it('still refuses an audience the trigger entity does not have (dispatcher on an invoice)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_SENT',
      trigger_config: null,
      steps: [staffText(0, { recipients: ['dispatcher'], body: 'Invoice {{invoice.number}} went out' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.recipients',
      message: 'Recipient "dispatcher" is not available for this trigger',
    });
  });

  it('still refuses the custom-email audience on a text step', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [staffText(0, { recipients: ['custom'], body: 'Heads up' })],
    });
    // The element enum rejects it, so the path carries the array INDEX, and the sentence is
    // the text channel's own rather than zod's - which is the reason textRecipientKey is a
    // separate enum from teamRecipientKey over the same keys.
    expect(issues).toEqual([
      {
        step_index: 0,
        path: 'config.recipients.0',
        message: 'That recipient isn’t available for text messages - pick another',
      },
    ]);
  });

  it('still refuses a custom_emails field on a text step', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [staffText(0, { recipients: ['customer'], custom_emails: ['a@b.com'], body: 'Heads up' })],
    });
    // .strict() is the refusal, so the issue lands on the object rather than on a field.
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ step_index: 0, path: 'config' });
  });

  // The regression guard the slice names. Every gallery recipe still validates, and the four
  // customer texts still mean what they meant: the literal-'customer' element type used to
  // GUARANTEE that structurally, and after the widening only an assertion does.
  it('leaves every gallery template validating, with the four customer texts still customer-addressed', () => {
    const textRecipes = TEMPLATES.filter((t) => t.action_type === 'SEND_SMS');
    expect(textRecipes).toHaveLength(4);

    for (const tpl of TEMPLATES) {
      const step_type = tpl.action_type === 'SEND_SMS' ? 'SEND_TEXT' : 'SEND_EMAIL';
      const { recipient, body, subject, custom_email } = tpl.action_config;
      const steps: WorkflowStepInput[] = tpl.steps
        ? tpl.steps.map((step, position) => ({ position, step_type: step.step_type, config: step.config }))
        : [
            {
              position: 0,
              step_type,
              config:
                step_type === 'SEND_TEXT'
                  ? { recipient, body }
                  : { recipient, subject: subject ?? '', body, ...(custom_email ? { custom_email } : {}) },
            },
          ];
      expect(
        validateWorkflowDefinition({
          trigger_type: tpl.trigger_type,
          trigger_config: tpl.trigger_config ?? null,
          send_window: tpl.send_window,
          steps,
        }),
        tpl.key,
      ).toEqual([]);
    }

    for (const tpl of textRecipes) {
      const parsed = sendTextConfigSchema.safeParse({
        recipient: tpl.action_config.recipient,
        body: tpl.action_config.body,
      });
      expect(parsed.success, tpl.key).toBe(true);
      expect(parsed.success && parsed.data, tpl.key).toMatchObject({ recipients: ['customer'] });
    }
  });
});

describe('validateWorkflowDefinition — rule 7: custom/specific_user companion fields', () => {
  it('requires custom_emails for a custom email recipient', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.custom_emails',
      message: 'Enter the email address to send to',
    });
  });

  it('requires user_ids for a specific_user recipient', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'specific_user' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.user_ids',
      message: 'Pick the team member to notify',
    });
  });

  it('flags user_ids present WITHOUT specific_user selected (iff, reverse direction)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: {
            recipients: ['all_admins'],
            subject: 'Hi',
            body: 'FYI',
            user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'],
          },
        },
      ],
    });
    expect(issues.some((i) => i.path === 'config.user_ids')).toBe(true);
  });

  it('flags custom_emails present WITHOUT custom selected (iff, reverse direction)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['customer'], subject: 'Hi', body: 'Hello', custom_emails: ['a@b.com'] },
        },
      ],
    });
    expect(issues.some((i) => i.path === 'config.custom_emails')).toBe(true);
  });

  it('passes custom email with custom_emails present', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { recipient: 'custom', custom_email: 'a@b.com' })],
    });
    expect(issues).toEqual([]);
  });

  it('passes specific_user with user_ids present', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: {
            recipients: ['specific_user'],
            subject: 'Hi',
            body: 'FYI',
            user_ids: ['aaaaaaaa-0000-0000-0000-000000000001'],
          },
        },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('legacy singular { recipient } still validates end-to-end (back-compat)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [{ position: 0, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Hi', body: 'Hello' } }],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 8: merge fields must be legal for the trigger', () => {
  it('flags an unavailable field used in the body', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0, { body: 'Total: {{estimate.total}}' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.body',
      message: "The field {{estimate.total}} isn't available for this trigger",
    });
  });

  it('flags an unavailable field used in the subject (email only)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendEmailStep(0, { subject: 'Re: {{invoice.number}}' })],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.body',
      message: "The field {{invoice.number}} isn't available for this trigger",
    });
  });

  it('passes a field that IS available for the trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0, { body: 'Job {{job.number}} at {{job.scheduled_time}}' })],
    });
    expect(issues).toEqual([]);
  });
});

describe('validateWorkflowDefinition — rule 9: STOP_IF condition must be legal for the trigger entity', () => {
  it('flags any STOP_IF condition on a lead trigger (empty legal set)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'LEAD_CREATED',
      steps: [stopIfStep(0, 'job_cancelled')],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.condition',
      message: "This stop condition isn't available for this trigger",
    });
  });

  it('flags a condition from the wrong entity (invoice condition on a job trigger)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [stopIfStep(0, 'invoice_paid')],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.condition',
      message: "This stop condition isn't available for this trigger",
    });
  });

  it('passes a legal condition for the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [stopIfStep(0, 'job_cancelled')],
    });
    expect(issues).toEqual([]);
  });
});

// ── rule 10: anchored WAIT — legacy relative still valid, anchor must match entity ──

describe('validateWorkflowDefinition — rule 10: anchored wait legality', () => {
  it('still accepts a legacy relative wait (no mode key)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { duration_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });
  it('accepts an anchored wait whose anchor matches the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });
  it('rejects an anchor that does not belong to the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.anchor')).toBe(true);
  });
});

// ── rule 11: anchored WAIT — disallowed under a terminal (past-state) trigger ──

describe('validateWorkflowDefinition — rule 11: anchored wait disallowed under a terminal trigger', () => {
  it('flags an anchored wait whose trigger is WALKTHROUGH_COMPLETED (fires after the fact)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'config.mode',
      message: 'A ‘wait until before/after’ timer needs a trigger with an upcoming date — this trigger fires after the fact',
    });
  });

  it('flags an anchored wait whose trigger is WALKTHROUGH_CANCELLED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_CANCELLED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'after', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('flags an anchored wait whose trigger is JOB_COMPLETED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('flags an anchored wait whose trigger is JOB_CANCELLED', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_CANCELLED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } }],
    });
    expect(issues.some((i) => i.path === 'config.mode')).toBe(true);
  });

  it('allows an anchored wait whose trigger is WALKTHROUGH_SCHEDULED (an upcoming date)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'WALKTHROUGH_SCHEDULED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 } }],
    });
    expect(issues).toEqual([]);
  });

  it('still accepts a legacy relative wait under a terminal trigger (only anchored waits are timing-sensitive)', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'WAIT', config: { duration_minutes: 60 } }],
    });
    expect(issues).toEqual([]);
  });
});

// Rule 12 (the in-app step channel-narrowed its recipients away from the
// customer) is gone with the step itself: validateStep now stops at the missing
// config schema, so no recipient of a retired step is ever reached. The
// equivalent narrowing for the LEGACY AutomationRule engine, which still offers
// that action, is unaffected and still covered in catalog.test.ts.

// ── the retired in-app step is no longer a configurable step type ──────────

// The Postgres enum keeps its NOTIFY_TEAM label so historic rows still resolve,
// so a stored draft can still NAME the retired step. What changed is that no
// config schema answers for it any more: the config-schema map is keyed by the
// AUTHORABLE union, so an organization still holding one is told to remove it
// instead of being quietly allowed to keep publishing it.
describe('validateWorkflowDefinition - the retired in-app step is no longer configurable', () => {
  const retiredStep: WorkflowStepInput = {
    position: 0,
    step_type: 'NOTIFY_TEAM',
    config: { recipients: ['all_admins'], body: 'FYI' },
  };

  // The generic "no longer supported" copy is right for a step type this build
  // has simply never heard of. The in-app step is different: the product made a
  // decision about it, the admin has somewhere to go for the same outcome, and
  // the sentence has to say so or a support engineer ends up explaining it.
  it('names the step and says where in-app notifications come from now', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [waitStep(0), { ...retiredStep, position: 1 }],
    });
    expect(issues).toContainEqual({
      step_index: 1,
      path: 'step_type',
      message: retiredInAppStepMessage(1),
    });
    const message = retiredInAppStepMessage(1);
    expect(message, 'the admin has to know WHICH step to delete').toContain('Step 2');
    expect(message, 'and where the notifications went').toMatch(/bell/i);
    expect(message, 'and what to do about it').toMatch(/remove/i);
    expect(message, 'in product English, never an internal label').not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  // Ordering, not wording: validateStep looks a config schema up before it parses
  // anything, and the retired step has no schema, so a rejection placed anywhere
  // but the very top of the function loses to the generic message below it.
  it('the in-app rejection wins over the generic unrecognised-step message', () => {
    const issues = validateWorkflowDefinition({ trigger_type: 'JOB_SCHEDULED', steps: [retiredStep] });
    expect(issues.map((i) => i.message)).not.toContain(UNSUPPORTED_STEP_MESSAGE);
    expect(issues).toEqual([{ step_index: 0, path: 'step_type', message: retiredInAppStepMessage(0) }]);
  });

  // The same ordering seen from the other side: a stored config that no schema
  // would accept must still produce the deliberate sentence and nothing else.
  // A config error here would read as "fix the fields and carry on", which is
  // the opposite of what the admin has to do.
  it('the in-app rejection wins over a config that could not parse', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [{ position: 0, step_type: 'NOTIFY_TEAM', config: { recipients: ['not-an-audience'], body: '' } }],
    });
    expect(issues).toEqual([{ step_index: 0, path: 'step_type', message: retiredInAppStepMessage(0) }]);
  });

  // The escape hatch, and the admin's only route forward: delete the step and the
  // rest of the workflow is publishable with no other change.
  it('removing the step leaves the same definition clean', () => {
    const withStep = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [{ ...retiredStep, position: 0 }, sendTextStep(1)],
    });
    expect(withStep).not.toEqual([]);
    const without = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [sendTextStep(0)],
    });
    expect(without).toEqual([]);
  });

  // The retirement is of the whole step, not of one audience on it. Reporting a
  // recipient problem would read as "pick a different audience and carry on".
  it('never reports it as a recipient problem', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [{ ...retiredStep, config: { recipients: ['customer'], body: 'FYI' } }],
    });
    expect(issues.filter((i) => i.path === 'config.recipients')).toEqual([]);
  });

  it('keeps validating the steps after it', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      steps: [retiredStep, waitStep(1, 2)],
    });
    expect(issues.some((i) => i.step_index === 1 && i.path.startsWith('config.duration_minutes'))).toBe(true);
  });

  it('isSupportedStepType answers false for it and true for every authorable type', () => {
    expect(isSupportedStepType('NOTIFY_TEAM')).toBe(false);
    for (const stepType of AUTHORABLE_STEP_TYPES) {
      expect(isSupportedStepType(stepType)).toBe(true);
    }
  });
});

// ── date-anchored triggers (JOB/LEAD/INVOICE/ESTIMATE_DATE_ANCHORED) ────────

const emailStep = {
  position: 0,
  step_type: 'SEND_EMAIL' as const,
  config: { recipients: ['customer'], subject: 'Reminder', body: 'Your invoice is due soon.' },
};

/** A task has no customer, so a task workflow's step has to address staff. */
const taskEmailStep = {
  position: 0,
  step_type: 'SEND_EMAIL' as const,
  config: { recipients: ['assignees'], subject: 'Due soon: {{task.title}}', body: 'Due {{task.due_date}}.' },
};

describe('validateWorkflowDefinition — date-anchored triggers', () => {
  it('accepts a valid invoice due-date reminder', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toEqual([]);
  });

  it('rejects an anchor that does not belong to the trigger entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config.anchor',
      message: 'This timing anchor isn’t available for this trigger',
    });
  });

  it('rejects a missing trigger_config on a date-anchored trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: null,
      steps: [emailStep],
    });
    expect(issues.some((i) => i.path === 'trigger_config')).toBe(true);
  });

  it('rejects a negative or over-bound offset', () => {
    const tooBig = validateWorkflowDefinition({
      trigger_type: 'JOB_DATE_ANCHORED',
      trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 * 24 * 91 },
      steps: [emailStep],
    });
    expect(tooBig.some((i) => i.path.startsWith('trigger_config'))).toBe(true);
  });

  /**
   * Spec B slice 5. DATE_ANCHORED_TRIGGERS in workflowValidation.ts is hand-written and
   * derived from nothing, so a missing member here is silent in the worst way: the config
   * falls through to the `trigger.timeBased` branch, which for a non-timeBased trigger
   * rejects the config outright with "remove the timing offset" - so the reminder cannot be
   * SAVED at all, with an error message about a field the admin never filled in.
   */
  it('accepts a task due-date reminder in the BEFORE direction', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DATE_ANCHORED',
      trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
      steps: [taskEmailStep],
    });
    expect(issues).toEqual([]);
  });

  it('accepts the same reminder in the AFTER direction - the overdue chase', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DATE_ANCHORED',
      trigger_config: { anchor: 'task.due_at', direction: 'after', offset_minutes: 1440 },
      steps: [taskEmailStep],
    });
    expect(issues).toEqual([]);
  });

  it('rejects an anchor that belongs to another entity on a task trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DATE_ANCHORED',
      trigger_config: { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 },
      steps: [taskEmailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config.anchor',
      message: 'This timing anchor isn’t available for this trigger',
    });
  });

  it('rejects a task reminder with no trigger_config at all', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DATE_ANCHORED',
      trigger_config: null,
      steps: [taskEmailStep],
    });
    expect(issues.some((i) => i.path === 'trigger_config')).toBe(true);
  });

  it('still rejects an offset on a plain event trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_COMPLETED',
      trigger_config: { offset_minutes: 1440 },
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config',
      message: 'This trigger fires on the event itself — remove the timing offset',
    });
  });
});

// ── SRVW-113: JOB_SUB_STATUS_ENTERED ────────────────────────────────────────

describe('subStatusTriggerConfigSchema', () => {
  const SUB_STATUS_ID = '00000000-0000-0000-0000-0000000000d1';

  it('accepts a bare sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({ sub_status_id: SUB_STATUS_ID }).success).toBe(true);
  });

  it('rejects a non-uuid sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({ sub_status_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects a missing sub_status_id', () => {
    expect(subStatusTriggerConfigSchema.safeParse({}).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      subStatusTriggerConfigSchema.safeParse({ sub_status_id: SUB_STATUS_ID, extra: 'nope' }).success,
    ).toBe(false);
  });
});

describe('validateWorkflowDefinition — JOB_SUB_STATUS_ENTERED requires a sub_status_id', () => {
  const SUB_STATUS_ID = '00000000-0000-0000-0000-0000000000d1';

  it('accepts a valid sub_status_id', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: SUB_STATUS_ID },
      steps: [emailStep],
    });
    expect(issues).toEqual([]);
  });

  it('rejects a missing trigger_config — unlike a plain event trigger, this one needs the label picked', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: null,
      steps: [emailStep],
    });
    expect(issues).toContainEqual({
      step_index: -1,
      path: 'trigger_config.sub_status_id',
      message: 'Pick which sub-status should trigger this automation',
    });
  });

  it('rejects a non-uuid sub_status_id', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: 'not-a-uuid' },
      steps: [emailStep],
    });
    expect(issues.some((i) => i.path.startsWith('trigger_config'))).toBe(true);
  });

  it('the job.sub_status merge field is legal in copy for this trigger', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: SUB_STATUS_ID },
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: { recipients: ['customer'], subject: 'Update', body: 'Now: {{job.sub_status}}' },
        },
      ],
    });
    expect(issues).toEqual([]);
  });
});

// ── unrecognised step types ─────────────────────────────────────────────────
// validateWorkflowDefinition runs on EVERY read (toApiWorkflow), not only at
// publish, so a step type with no config schema must degrade to an issue. If it
// throws, the whole /automations list 500s for that organization.

describe('a step type with no config schema', () => {
  const unknownStep = (position: number): WorkflowStepInput => ({
    position,
    step_type: 'NOT_A_REAL_STEP_TYPE' as WorkflowStepInput['step_type'],
    config: { anything: true },
  });

  it('yields a validation issue instead of throwing', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [unknownStep(0)],
    });
    expect(issues).toContainEqual({
      step_index: 0,
      path: 'step_type',
      message: UNSUPPORTED_STEP_MESSAGE,
    });
  });

  it('speaks product English, never an internal type name', () => {
    expect(UNSUPPORTED_STEP_MESSAGE).not.toContain('NOT_A_REAL_STEP_TYPE');
    expect(UNSUPPORTED_STEP_MESSAGE).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  it('validation continues past it and still reports issues on later steps', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      steps: [unknownStep(0), sendTextStep(1, { body: 'Hi {{not_a_field}}' })],
    });
    expect(issues.some((i) => i.step_index === 0 && i.path === 'step_type')).toBe(true);
    expect(issues).toContainEqual({
      step_index: 1,
      path: 'config.body',
      message: "The field {{not_a_field}} isn't available for this trigger",
    });
  });
});

// ── Spec B slice 1: task workflows ───────────────────────────────────────────

describe('validateWorkflowDefinition - task workflows', () => {
  const taskEmail = (position: number, overrides: Record<string, unknown> = {}): WorkflowStepInput => ({
    position,
    step_type: 'SEND_EMAIL',
    config: {
      recipients: ['assignees'],
      subject: 'New task: {{task.title}}',
      body: 'Due {{task.due_date}} - {{task.link}}',
      ...overrides,
    },
  });

  it('accepts a one-step email addressed to the assignees', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TASK_CREATED',
        trigger_config: null,
        steps: [taskEmail(0)],
      }),
    ).toEqual([]);
  });

  it('accepts the watchers audience too', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TASK_CREATED',
        trigger_config: null,
        steps: [taskEmail(0, { recipients: ['assignees', 'watchers'] })],
      }),
    ).toEqual([]);
  });

  it('rejects the customer audience on a task - there is no customer to reach', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_CREATED',
      trigger_config: null,
      steps: [taskEmail(0, { recipients: ['customer'], body: 'Hi' })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('config.recipients');
  });

  // Spec C slice 1 turned this test around. It used to read "rejects a text step on a task
  // workflow, naming text as unavailable for tasks", and it was pinning a guard that has
  // since been deleted: with SMS narrowed to `customer` a task trigger had ZERO legal text
  // audiences, so the guard caught the step early and said so in one sentence rather than
  // reporting every selected audience as unavailable. Now that a text reaches every audience
  // an email reaches, that guard could never fire again and the step is simply legal.
  it('accepts a text step on a task workflow addressed to the people doing the task', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TASK_CREATED',
        trigger_config: null,
        steps: [
          {
            position: 0,
            step_type: 'SEND_TEXT',
            config: { recipients: ['assignees'], body: 'Task {{task.number}} is yours' },
          },
        ],
      }),
    ).toEqual([]);
  });

  // The other half of the same rule, and the reason the entity narrowing had to survive the
  // widening: a task has no customer on EITHER channel.
  it('rejects the customer audience on a task text step, as it does on a task email', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_CREATED',
      trigger_config: null,
      steps: [{ position: 0, step_type: 'SEND_TEXT', config: { recipients: ['customer'], body: 'Hi' } }],
    });
    expect(issues).toEqual([
      {
        step_index: 0,
        path: 'config.recipients',
        message: 'Recipient "customer" is not available for this trigger',
      },
    ]);
  });

  it('rejects a stop-if step on a task - no condition is legal for the entity', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_CREATED',
      trigger_config: null,
      steps: [taskEmail(0), { position: 1, step_type: 'STOP_IF', config: { condition: 'job_completed' } }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ step_index: 1, path: 'config.condition' });
  });

  it('rejects a customer merge field in a task email body', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_CREATED',
      trigger_config: null,
      steps: [taskEmail(0, { body: 'Hi {{customer.first_name}}' })],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('config.body');
  });

  it('refuses a trigger_config on TASK_CREATED - it fires on the event itself', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_CREATED',
      trigger_config: { offset_minutes: 60 },
      steps: [taskEmail(0)],
    });
    expect(issues.some((i) => i.path === 'trigger_config')).toBe(true);
  });

  it('lists no stop-if condition for the task entity', () => {
    expect(STOP_IF_CONDITIONS.task).toEqual([]);
  });
});

// ── Spec B slice 4: the deleted-task body may only reference the snapshot ─────

describe('validateWorkflowDefinition - TASK_DELETED merge fields', () => {
  const deletedEmail = (body: string, subject = 'Cancelled: {{task.title}}'): WorkflowStepInput => ({
    position: 0,
    step_type: 'SEND_EMAIL',
    config: { recipients: ['assignees', 'watchers'], subject, body },
  });

  it('accepts a body built from the number and the title alone', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TASK_DELETED',
        trigger_config: null,
        steps: [deletedEmail('Task {{task.number}} - {{task.title}} - has been deleted at {{org.name}}.')],
      }),
    ).toEqual([]);
  });

  /**
   * The other half of the same rule, and the half that only became true on 2026-09-15: a body
   * still carrying the retired `{{recipient.first_name}}` is REFUSED here, on every trigger.
   *
   * That refusal is not a nicety - it is the second consequence of the removal, after the raw
   * braces executors.test.ts pins. An organisation's saved copy that still holds the token is
   * unsaveable until it is rewritten, which is exactly why
   * 20260915170000_drop_recipient_first_name_from_saved_copy rewrites it rather than leaving
   * the office to discover this the next time they open an automation.
   */
  it('refuses a body that still references the retired recipient field', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DELETED',
      trigger_config: null,
      steps: [deletedEmail('Task {{task.number}} has been deleted, {{recipient.first_name}}.')],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ step_index: 0, path: 'config.body' });
    expect(issues[0].message).toContain('{{recipient.first_name}}');
  });

  /**
   * The AC this slice exists to make true at SAVE time rather than at send time. The row is
   * hard-deleted, so a due date rendered from a payload that never carried one is an empty
   * string in the middle of a sentence - the office reads that as a broken template. The
   * refusal is what stops the template being written in the first place.
   */
  it.each([
    'task.due_date',
    'task.status',
    'task.priority',
    'task.assignee_names',
    'task.link',
    'task.linked_record',
  ])('rejects a body referencing {{%s}} - not captured in the pre-delete snapshot', (field) => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DELETED',
      trigger_config: null,
      steps: [deletedEmail(`Task {{task.title}} was due {{${field}}}`)],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe('config.body');
    expect(issues[0].message).toBe(`The field {{${field}}} isn't available for this trigger`);
  });

  it('rejects the same field in the SUBJECT as well as the body', () => {
    const issues = validateWorkflowDefinition({
      trigger_type: 'TASK_DELETED',
      trigger_config: null,
      steps: [deletedEmail('{{task.title}} is gone', 'Due {{task.due_date}}')],
    });
    expect(issues.some((i) => i.message.includes('{{task.due_date}}'))).toBe(true);
  });

  /** The same field on a LIVE task trigger is perfectly legal - the narrowing is per trigger. */
  it('still allows those fields on TASK_CREATED, whose row is there to be read', () => {
    expect(
      validateWorkflowDefinition({
        trigger_type: 'TASK_CREATED',
        trigger_config: null,
        steps: [deletedEmail('Due {{task.due_date}} - {{task.link}}')],
      }),
    ).toEqual([]);
  });
});

// ── "If empty, fill with" ────────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// A send step stores its per-field fallback map beside the body. Both messaging schemas are
// `.strict()`, so without an entry here the builder's first save with a popover value would
// come back "needs setup".

describe('send step fallbacks', () => {
  it('accepts a fallbacks map on an email step and a text step', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipients: ['customer'],
        subject: 'Hi',
        body: "Who's coming: {{technician.names}}.",
        fallbacks: { 'technician.names': 'Our team', 'customer.first_name': '' },
      }).success,
    ).toBe(true);
    expect(
      sendTextConfigSchema.safeParse({
        recipients: ['customer'],
        body: '{{technician.names}} is on the way.',
        fallbacks: { 'technician.names': 'Your technician' },
      }).success,
    ).toBe(true);
  });

  it('refuses a multi-line fallback: the text lands mid-sentence', () => {
    const r = sendEmailConfigSchema.safeParse({
      recipients: ['customer'],
      subject: 'Hi',
      body: 'b',
      fallbacks: { 'technician.names': 'Our team\nwill be there' },
    });
    expect(r.success).toBe(false);
    // The refusal is the one-line rule on that entry, not the strict schema rejecting a
    // `fallbacks` key it never knew about.
    expect(r.success ? [] : r.error.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: ['fallbacks', 'technician.names'], message: 'Keep the fallback text to one line' },
    ]);
  });
});
