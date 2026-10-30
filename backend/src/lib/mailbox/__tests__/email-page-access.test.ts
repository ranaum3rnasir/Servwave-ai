/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.25 - "Can't read: Email page is off for this person".

   Pure: a person's resolved switch values in, whether the Email page is closed to them out. The "no preset
   triggers it" rule is proved from the catalog's own presets (every built-in role), never from a copy of them.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES } from '../../permissions/switches/catalog';
import { presetValues } from '../../permissions/switches/store';
import { EMAIL_PAGE_SWITCHES, emailPageClosed } from '../email-page-access';

describe('emailPageClosed', () => {
  it.each(BUILT_IN_ROLES)('is not closed on the %s preset', (role) => {
    expect(emailPageClosed(presetValues(role))).toBe(false);
  });

  it('is closed when Show Email is off, whatever else is on', () => {
    expect(emailPageClosed({ ...presetValues('ADMIN'), show_email: false })).toBe(true);
  });

  it('is closed when Access Communication is off, even with Show Email still on', () => {
    expect(emailPageClosed({ ...presetValues('ADMIN'), access_communication: false })).toBe(true);
  });

  it('opens again when both are on', () => {
    expect(emailPageClosed({ ...presetValues('SALES'), show_email: true, access_communication: true })).toBe(false);
  });

  it('is closed for a blank set (a role made from nothing)', () => {
    expect(emailPageClosed(presetValues(null))).toBe(true);
  });

  it('names exactly the two switches the PRD names', () => {
    expect([...EMAIL_PAGE_SWITCHES].sort()).toEqual(['access_communication', 'show_email']);
  });
});
