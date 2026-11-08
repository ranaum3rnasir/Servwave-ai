import { describe, it, expect } from 'vitest';
import { stepSentence, sentenceText } from './stepSentence';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/** Minimal catalog fixture — the stop_if labels and anchor labels stepSentence reads. */
const CATALOG = {
  triggers: {},
  actions: {},
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
    lead: [{ key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough' }],
    invoice: [{ key: 'invoice.due_date', label: 'the invoice due date' }],
    estimate: [{ key: 'estimate.valid_until', label: 'the estimate expiration' }],
  },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: {
    conditions: {},
    labels: { invoice_paid: 'the invoice is paid', job_completed: 'the job was completed' },
  },
} as unknown as WorkflowCatalog;

describe('stepSentence', () => {
  it('WAIT: bolds the humanized duration when configured', () => {
    const s = stepSentence({ step_type: 'WAIT', config: { duration_minutes: 24 * 60 } }, CATALOG);
    expect(s.configured).toBe(true);
    expect(sentenceText(s)).toBe('Wait 1 day');
    expect(s.segments.find((seg) => seg.strong)?.text).toBe('1 day');
  });

  it('WAIT: unconfigured when duration is missing or zero → "Set up this step…"', () => {
    expect(stepSentence({ step_type: 'WAIT', config: {} }, CATALOG).configured).toBe(false);
    const zero = stepSentence({ step_type: 'WAIT', config: { duration_minutes: 0 } }, CATALOG);
    expect(zero.configured).toBe(false);
    expect(sentenceText(zero)).toBe('Set up this step…');
  });

  it('WAIT: anchored mode bolds "<offset> <direction> <anchor label>" after "Wait until "', () => {
    const s = stepSentence(
      {
        step_type: 'WAIT',
        config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 24 * 60 },
      },
      CATALOG,
    );
    expect(s.configured).toBe(true);
    expect(sentenceText(s)).toBe('Wait until 1 day before the walkthrough');
    expect(s.segments.find((seg) => seg.strong)?.text).toBe('1 day before the walkthrough');
  });

  it('WAIT: anchored mode targeting the job anchor, "after" direction', () => {
    const s = stepSentence(
      { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 } },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Wait until 1 hour after the appointment');
  });

  it('WAIT: anchored mode is unconfigured until anchor, direction, and offset are all present', () => {
    expect(stepSentence({ step_type: 'WAIT', config: { mode: 'anchored' } }, CATALOG).configured).toBe(false);
    expect(
      sentenceText(stepSentence({ step_type: 'WAIT', config: { mode: 'anchored' } }, CATALOG)),
    ).toBe('Set up this step…');
    expect(
      stepSentence(
        { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before' } },
        CATALOG,
      ).configured,
    ).toBe(false);
    expect(
      stepSentence(
        { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'not_a_real_anchor', direction: 'before', offset_minutes: 60 } },
        CATALOG,
      ).configured,
    ).toBe(false);
  });

  it('WAIT: anchored mode is unconfigured when the catalog is undefined (label comes from the catalog now)', () => {
    const s = stepSentence(
      { step_type: 'WAIT', config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 } },
      undefined,
    );
    expect(s.configured).toBe(false);
  });

  it('WAIT: a legacy mode-less config still uses the relative phrasing (regression guard)', () => {
    const s = stepSentence({ step_type: 'WAIT', config: { duration_minutes: 90 } }, CATALOG);
    expect(sentenceText(s)).toBe('Wait 90 minutes');
  });

  it('SEND_TEXT: "Text the customer" once a body exists', () => {
    const s = stepSentence({ step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'Hi' } }, CATALOG);
    expect(s.configured).toBe(true);
    expect(sentenceText(s)).toBe('Text the customer');
    expect(s.segments.find((seg) => seg.strong)?.text).toBe('the customer');
  });

  it('SEND_TEXT: an empty body is unconfigured', () => {
    expect(
      stepSentence({ step_type: 'SEND_TEXT', config: { recipient: 'customer', body: '   ' } }, CATALOG).configured,
    ).toBe(false);
  });

  it('SEND_EMAIL: bolds the recipient label', () => {
    const s = stepSentence(
      { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Hi', body: 'x' } },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Email the customer');
  });

  it('SEND_EMAIL: reads the v2.1 recipients array and joins 2 with "and"', () => {
    const s = stepSentence(
      { step_type: 'SEND_EMAIL', config: { recipients: ['customer', 'dispatcher'], subject: 'Hi', body: 'x' } },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Email the customer and the dispatcher');
    expect(s.segments.find((seg) => seg.strong)?.text).toBe('the customer and the dispatcher');
  });

  it('SEND_EMAIL: still renders a legacy singular recipient (not "the recipient")', () => {
    const s = stepSentence(
      { step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 'Hi', body: 'x' } },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Email the customer');
  });

  it('SEND_EMAIL: joins 3+ recipients with an Oxford comma', () => {
    const s = stepSentence(
      {
        step_type: 'SEND_EMAIL',
        config: { recipients: ['customer', 'dispatcher', 'salesperson'], subject: 'Hi', body: 'x' },
      },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Email the customer, the dispatcher, and the salesperson');
  });

  it('SEND_TEXT: also reads the recipients array (shared clause helper)', () => {
    const s = stepSentence(
      { step_type: 'SEND_TEXT', config: { recipients: ['customer', 'dispatcher'], body: 'hi' } },
      CATALOG,
    );
    expect(sentenceText(s)).toBe('Text the customer and the dispatcher');
  });

  it.each([
    ['assigned_team', 'the assigned team'],
    ['dispatcher', 'the dispatcher'],
    ['salesperson', 'the salesperson'],
    ['creator', 'the creator'],
    ['assignees', 'the assignees'],
    ['watchers', 'the watchers'],
    // Spec B slice 2: TASK_ASSIGNED is the first task trigger to offer this key, and a
    // missing entry reads as the '?? the recipient' fallback with nothing going red.
    ['assigned_user', 'the assigned team member'],
    // Spec C slice 8: the last key this map was missing. TECH_UNASSIGNED and
    // WALKTHROUGH_PERFORMER_REMOVED offer it, the text step can now be addressed to it, and
    // without an entry the bubble reads "Text the recipient" with nothing going red.
    ['removed_user', 'the removed team member'],
  ] as const)('labels the new %s audience key as %s', (key, label) => {
    const s = stepSentence({ step_type: 'SEND_TEXT', config: { recipients: [key], body: 'x' } }, CATALOG);
    expect(sentenceText(s)).toBe(`Text ${label}`);
  });

  it('a step type that is no longer authorable gets no sentence', () => {
    // The storage label survives so historic rows still render elsewhere; the
    // bubble is an authoring surface, so a stored in-app step reads as
    // unconfigured and the config drawer is what tells the admin to remove it.
    const s = stepSentence({ step_type: 'NOTIFY_TEAM', config: { recipient: 'all_admins', body: 'x' } }, CATALOG);
    expect(s.configured).toBe(false);
  });

  it('STOP_IF: resolves the condition to its catalog label', () => {
    const s = stepSentence({ step_type: 'STOP_IF', config: { condition: 'invoice_paid' } }, CATALOG);
    expect(s.configured).toBe(true);
    expect(sentenceText(s)).toBe('Stop if the invoice is paid');
    expect(s.segments.find((seg) => seg.strong)?.text).toBe('the invoice is paid');
  });

  it('STOP_IF: no condition is unconfigured', () => {
    expect(stepSentence({ step_type: 'STOP_IF', config: {} }, CATALOG).configured).toBe(false);
  });

  it('falls back gracefully when the catalog is undefined (condition slug de-underscored)', () => {
    const s = stepSentence({ step_type: 'STOP_IF', config: { condition: 'invoice_paid' } }, undefined);
    expect(sentenceText(s)).toBe('Stop if invoice paid');
  });
});
