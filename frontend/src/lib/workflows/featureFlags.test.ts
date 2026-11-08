import { describe, it, expect } from 'vitest';
import { lockedStepTypesFor, DEFAULT_STEP_LOCK_COPY, SMS_LOCKED_BADGE, SMS_LOCKED_TOOLTIP } from './featureFlags';
import type { WorkflowCatalog } from '@/lib/api/workflows';

function catalogWith(sms_available: boolean): WorkflowCatalog {
  return { capabilities: { sms_available } } as unknown as WorkflowCatalog;
}

describe('lockedStepTypesFor', () => {
  it('unlocks SEND_TEXT when the org can text', () => {
    expect(lockedStepTypesFor(catalogWith(true))).toEqual([]);
  });

  it('locks SEND_TEXT when the org cannot text', () => {
    expect(lockedStepTypesFor(catalogWith(false))).toEqual(['SEND_TEXT']);
  });

  it('fails closed (locked) while the catalog is still loading', () => {
    expect(lockedStepTypesFor(undefined)).toEqual(['SEND_TEXT']);
  });

  it('fails closed (locked) for a stale fixture missing capabilities', () => {
    expect(lockedStepTypesFor({} as unknown as WorkflowCatalog)).toEqual(['SEND_TEXT']);
  });
});

// ── Spec C slice 8: the per-SUBJECT half of the lock is gone ─────────────────
//
// Spec B added it because a text could only reach the customer, so a task - which has none -
// had zero legal text audiences and the step was offered only to be refused at save. A text
// now reaches every audience an email reaches, so a task workflow can text its assignees and
// the subject has no say in the lock again. featureFlags.ts said so itself: "SMS reaching
// staff at all is Spec C; when that lands, this set empties."

describe('lockedStepTypesFor - the subject no longer has a say', () => {
  it('offers SEND_TEXT on a task workflow in an org that CAN text', () => {
    expect(lockedStepTypesFor(catalogWith(true))).toEqual([]);
  });

  it('locks it in an org that cannot, whatever the subject', () => {
    expect(lockedStepTypesFor(catalogWith(false))).toEqual(['SEND_TEXT']);
  });
});

// AC8: the per-ORG lock still fires for the same reason, and still says where to fix it.
// Only the audience half of the tooltip moved: Spec C made a text reach everyone an email
// reaches, so "text customers" understated what the locked step would give the org.
describe('the not-connected copy', () => {
  it('badges "Not connected", names both audiences, and points at Communication settings', () => {
    expect(DEFAULT_STEP_LOCK_COPY.badge).toBe(SMS_LOCKED_BADGE);
    expect(SMS_LOCKED_BADGE).toBe('Not connected');
    expect(DEFAULT_STEP_LOCK_COPY.tooltip).toBe(SMS_LOCKED_TOOLTIP);
    expect(SMS_LOCKED_TOOLTIP).toBe(
      'Connect a phone number in Communication settings to text a customer or your team from an automation.',
    );
  });
});
