import { describe, it, expect } from 'vitest';
import type { ZodTypeAny } from 'zod';
import * as stepSchemas from './stepSchemas';
import {
  STEP_CONFIG_SCHEMAS,
  waitConfigSchema,
  sendTextConfigSchema,
  sendEmailConfigSchema,
  stopIfConfigSchema,
  mergeFieldsIn,
  MERGE_FIELD_RE,
} from './stepSchemas';
import { AUTHORABLE_STEP_TYPES, type AuthorableStepType } from '@/lib/api/workflows';

/** First plain-English message zod produced for a given field path. */
function messageFor(result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }, field: string): string | undefined {
  if (result.success) return undefined;
  return result.error!.issues.find((i) => i.path.join('.') === field)?.message;
}

describe('waitConfigSchema — bounds mirror the backend (5..129600 whole minutes)', () => {
  it('rejects 4 minutes (below the floor)', () => {
    const r = waitConfigSchema.safeParse({ duration_minutes: 4 });
    expect(r.success).toBe(false);
  });
  it('accepts 5 minutes (the floor)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5 }).success).toBe(true);
  });
  it('accepts 129600 minutes (90 days, the ceiling)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129600 }).success).toBe(true);
  });
  it('rejects 129601 minutes (above the ceiling)', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 129601 }).success).toBe(false);
  });
  it('rejects a non-integer duration', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: 5.5 }).success).toBe(false);
  });
  it('rejects a non-numeric duration', () => {
    expect(waitConfigSchema.safeParse({ duration_minutes: Number.NaN }).success).toBe(false);
  });
});

describe('waitConfigSchema — anchored mode + legacy relative pass-through', () => {
  it('parses a legacy relative config with no mode key, defaulting mode to relative', () => {
    const r = waitConfigSchema.safeParse({ duration_minutes: 1440 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ mode: 'relative', duration_minutes: 1440 });
  });

  it('parses an explicit relative config', () => {
    expect(waitConfigSchema.safeParse({ mode: 'relative', duration_minutes: 60 }).success).toBe(true);
  });

  it('parses an anchored config', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
      offset_minutes: 1440,
    });
    expect(r.success).toBe(true);
  });

  it('accepts an anchored offset of 0 (exactly at the anchor)', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'after',
      offset_minutes: 0,
    });
    expect(r.success).toBe(true);
  });

  it('rejects an anchored config with an unrecognized anchor key', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'invoice.due_date',
      direction: 'before',
      offset_minutes: 1440,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an anchored config with an invalid direction', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'sideways',
      offset_minutes: 60,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an anchored offset above the 90-day ceiling', () => {
    const r = waitConfigSchema.safeParse({
      mode: 'anchored',
      anchor: 'job.scheduled_start',
      direction: 'before',
      offset_minutes: 129601,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a relative config below the 5-minute floor even with an explicit mode', () => {
    expect(waitConfigSchema.safeParse({ mode: 'relative', duration_minutes: 4 }).success).toBe(false);
  });
});

describe('sendTextConfigSchema - every audience an email reaches except custom, 1..320', () => {
  it('accepts a 250-char body (no error)', () => {
    const r = sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'a'.repeat(250) });
    expect(r.success).toBe(true);
  });
  it('rejects a 321-char body with the exact plain-English message', () => {
    const r = sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'a'.repeat(321) });
    expect(r.success).toBe(false);
    expect(messageFor(r, 'body')).toBe('Texts are capped at 320 characters');
  });
  it('rejects an empty body', () => {
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: '' }).success).toBe(false);
  });

  // Spec C slice 8. This describe used to end on "rejects a non-customer recipient", which was
  // the mirror's half of the customer-only constraint: the backend widened SEND_TEXT to the
  // staff audiences in slice 1, and until this enum followed, the builder rejected a staff
  // text client-side before a request was ever made.
  it.each(['assigned_team', 'dispatcher', 'salesperson', 'creator', 'all_admins', 'all_dispatchers', 'specific_user', 'removed_user', 'assigned_user', 'assignees', 'watchers'] as const)(
    'accepts the %s audience',
    (key) => {
      expect(sendTextConfigSchema.safeParse({ recipients: [key], body: 'hi' }).success).toBe(true);
    },
  );

  it('still refuses the custom-address audience - a handset has no address to resolve', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: ['custom'], body: 'hi' }).success).toBe(false);
  });

  it('still refuses the custom_emails companion field (.strict() is the enforcement)', () => {
    const r = sendTextConfigSchema.safeParse({
      recipients: ['customer'],
      body: 'hi',
      custom_emails: ['office@acme.com'],
    });
    expect(r.success).toBe(false);
  });

  it('accepts the user_ids companion for a named team member', () => {
    const r = sendTextConfigSchema.safeParse({ recipients: ['specific_user'], user_ids: ['u1'], body: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.user_ids).toEqual(['u1']);
  });

  it('folds a legacy singular user_id into user_ids[]', () => {
    const r = sendTextConfigSchema.safeParse({ recipient: 'specific_user', user_id: 'u1', body: 'hi' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.user_ids).toEqual(['u1']);
  });

  it('accepts the legacy assigned_techs spelling the multi-select still emits', () => {
    // toLegacySingularRecipient() mirrors a lone `assigned_team` back onto the singular field
    // as `assigned_techs`, so the mirror has to keep parsing what the picker actually sends.
    const r = sendTextConfigSchema.safeParse({
      recipients: ['assigned_team'],
      recipient: 'assigned_techs',
      body: 'hi',
    });
    expect(r.success).toBe(true);
  });

  it('rejects an empty recipients[] (min 1)', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: [], body: 'hi' }).success).toBe(false);
  });
});

describe('sendEmailConfigSchema — subject 1..200, body 1..5000, custom⇒email', () => {
  it('accepts a customer email with a subject + body', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
  });
  it('rejects an empty subject', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: '', body: 'Body' });
    expect(messageFor(r, 'subject')).toBe('Add a subject line');
  });
  it('rejects a 201-char subject', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'a'.repeat(201), body: 'Body' });
    expect(r.success).toBe(false);
  });
  it('rejects a 5001-char body', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'a'.repeat(5001) });
    expect(r.success).toBe(false);
  });
  it('requires custom_email when the recipient is custom (exact message)', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'custom', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(false);
    expect(messageFor(r, 'custom_email')).toBe('Enter the email address to send to');
  });
  it('flags a malformed custom_email', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'custom', subject: 'Hi', body: 'Body', custom_email: 'nope' });
    expect(messageFor(r, 'custom_email')).toBe('Enter a valid email address');
  });
  it('accepts a valid custom_email', () => {
    const r = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Body',
      custom_email: 'office@acme.com',
    });
    expect(r.success).toBe(true);
  });
  it('ignores an empty custom_email when the recipient is not custom', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body', custom_email: '' });
    expect(r.success).toBe(true);
  });
});

/** Fails to instantiate unless `T` is `never`, which is how the two type-level guards below report. */
type AssertNever<T extends never> = T;

/** Every value export of the module whose name mentions the retired in-app step. */
type RetiredStepExports = Extract<Lowercase<keyof typeof stepSchemas & string>, `${string}notify${string}`>;

/**
 * The compile-time twin of the runtime export check below. The runtime check can
 * only fail once a suite runs; this one fails `tsc -b`, so re-adding a
 * `notifyTeamConfigSchema` (or a `NOTIFY_RECIPIENT`) to the module stops the build
 * even if it is wired to nothing - the loophole the registry alone leaves open,
 * since a bare export sits outside `STEP_CONFIG_SCHEMAS`.
 */
type _NoRetiredStepExports = AssertNever<RetiredStepExports>;

describe('the retired in-app step keeps no authorable schema here', () => {
  // The type exports (form-values / recipient aliases) are erased at runtime, so
  // this only sees the value export. Their guard is `tsc -b`: with the aliases
  // gone, any surface that tries to author the retired step stops compiling.
  it('exports no config schema for the retired step type', () => {
    expect(Object.keys(stepSchemas).filter((name) => /notify/i.test(name))).toEqual([]);
  });

  it('registers a config schema for exactly the authorable step types', () => {
    expect(Object.keys(STEP_CONFIG_SCHEMAS).sort()).toEqual([...AUTHORABLE_STEP_TYPES].sort());
  });

  // The compile-time half of the same guard, and the reason the registry exists:
  // `STEP_CONFIG_SCHEMAS` is keyed by the authorable union, so giving the retired
  // step a schema here is a type error rather than a live parallel schema for a
  // step type nothing else will accept. `@ts-expect-error` fails `tsc -b` if the
  // line ever stops erroring, which is what makes this a checked property and not
  // a comment.
  it('cannot be given a registry entry for the retired step type', () => {
    const widened = {
      ...STEP_CONFIG_SCHEMAS,
      // @ts-expect-error - NOTIFY_TEAM is not authorable, so the registry has no slot for it
      NOTIFY_TEAM: stopIfConfigSchema,
    } satisfies Record<AuthorableStepType, ZodTypeAny>;
    expect(Object.keys(widened)).toContain('NOTIFY_TEAM');
  });
});

describe('stopIfConfigSchema — a non-empty condition slug', () => {
  it('accepts a condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: 'invoice_paid' }).success).toBe(true);
  });
  it('rejects an empty condition', () => {
    expect(stopIfConfigSchema.safeParse({ condition: '' }).success).toBe(false);
  });
});

describe('Task 19 — recipients[] array shape + legacy singular normalization', () => {
  it('SEND_EMAIL: a recipients[] array shape validates', () => {
    const r = sendEmailConfigSchema.safeParse({ recipients: ['customer', 'all_admins'], subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
  });

  it('SEND_EMAIL: legacy singular { recipient } still parses and normalizes to recipients[]', () => {
    const r = sendEmailConfigSchema.safeParse({ recipient: 'customer', subject: 'Hi', body: 'Body' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.recipients).toEqual(['customer']);
  });

  it('SEND_EMAIL: legacy { custom_email } folds into custom_emails[]', () => {
    const r = sendEmailConfigSchema.safeParse({
      recipient: 'custom',
      subject: 'Hi',
      body: 'Body',
      custom_email: 'office@acme.com',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.custom_emails).toEqual(['office@acme.com']);
  });

  it('SEND_EMAIL: an empty recipients[] is rejected (min 1)', () => {
    expect(sendEmailConfigSchema.safeParse({ recipients: [], subject: 'Hi', body: 'Body' }).success).toBe(false);
  });

  it('SEND_TEXT: recipients: ["customer"] validates; legacy singular parses', () => {
    expect(sendTextConfigSchema.safeParse({ recipients: ['customer'], body: 'Hi' }).success).toBe(true);
    expect(sendTextConfigSchema.safeParse({ recipient: 'customer', body: 'Hi' }).success).toBe(true);
  });
});

describe('mergeFieldsIn — same regex as the backend validator', () => {
  it('extracts every {{field}} in order', () => {
    expect(mergeFieldsIn('Hi {{customer.first_name}}, job {{job.number}}')).toEqual([
      'customer.first_name',
      'job.number',
    ]);
  });
  it('returns [] for copy with no fields', () => {
    expect(mergeFieldsIn('No merge fields here')).toEqual([]);
  });
  it('ignores tokens with characters outside [a-z_.]', () => {
    expect(mergeFieldsIn('{{Customer.Name}} {{ job.number }}')).toEqual([]);
  });
  it('exposes a global regex', () => {
    expect(MERGE_FIELD_RE.flags).toContain('g');
  });
});

// ── "If empty, fill with" ────────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// The per-field fallback map rides in the send-step config. Both send schemas are `.strict()`,
// so without this mirror of the backend field a step that carries fallbacks would parse as
// broken on the client while the server accepts it.

describe('send step fallbacks mirror the backend field', () => {
  it('accepts a fallbacks map on an email step and on a text step', () => {
    expect(
      sendEmailConfigSchema.safeParse({
        recipient: 'customer',
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
});
