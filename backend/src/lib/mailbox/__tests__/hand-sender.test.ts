/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.11 - the display name on a hand-written email:
   "<sender's name> at <company name>", safe to put in a header.

   Pure: names in, the name that enters the From header out.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { handDisplayName, MAX_SENDER_NAME_LENGTH } from '../hand-sender';

describe('handDisplayName', () => {
  it('reads "<sender\'s name> at <company name>"', () => {
    expect(handDisplayName({ first_name: 'Jane', last_name: 'Smith' }, 'Acme')).toBe('Jane Smith at Acme');
  });

  it('uses the one name there is', () => {
    expect(handDisplayName({ first_name: 'Jane', last_name: null }, 'Acme')).toBe('Jane at Acme');
    expect(handDisplayName({ first_name: '', last_name: 'Smith' }, 'Acme')).toBe('Smith at Acme');
  });

  it('falls back to what is left when a half is missing', () => {
    expect(handDisplayName({ first_name: null, last_name: null }, 'Acme')).toBe('Acme');
    expect(handDisplayName({ first_name: 'Jane', last_name: 'Smith' }, '  ')).toBe('Jane Smith');
    expect(handDisplayName({ first_name: null, last_name: null }, null)).toBe('');
  });

  it.each([
    ['a line break', 'Jane\r\nBcc: evil@example.com'],
    ['quotes', 'Jane "The Boss" Smith'],
    ['angle brackets', 'Jane <evil@example.com>'],
    ['commas and semicolons', 'Smith, Jane; evil@example.com'],
    ['a backslash', 'Jane\\" <x>'],
  ])('keeps %s in a person\'s name out of the header', (_label, hostile) => {
    const name = handDisplayName({ first_name: hostile, last_name: 'Smith' }, 'Acme');
    expect(name).not.toMatch(/[\r\n"<>,;\\\x00-\x1F]/);
    expect(name.endsWith(' at Acme')).toBe(true);
  });

  it('keeps a control character in the company name out of the header', () => {
    expect(handDisplayName({ first_name: 'Jane', last_name: 'Smith' }, 'Ac\r\nme')).toBe('Jane Smith at Ac me');
  });

  it('never exceeds the longest display name the header carries, and keeps the person whole', () => {
    const name = handDisplayName({ first_name: 'Jane', last_name: 'Smith' }, 'A Very Long Company Name '.repeat(10));
    expect(name.length).toBeLessThanOrEqual(MAX_SENDER_NAME_LENGTH);
    expect(name.startsWith('Jane Smith at A Very Long')).toBe(true);
  });
});
