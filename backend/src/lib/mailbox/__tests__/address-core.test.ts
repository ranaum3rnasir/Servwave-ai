/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.1 - the mailbox address register's pure core.

   No database and no mocks: the core builds and checks a candidate company part or address from plain
   values. Expected strings are written out by hand from the PRD, never produced by the code under test.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  RESERVED_LOCAL_PARTS,
  PURGED_ADDRESS_PREFIX,
  buildMailboxAddress,
  checkCompanyPart,
  hashLocalPart,
  isReservedLocalPart,
  mailboxDomainFrom,
  nextFreeCompanyPart,
  parseMailboxAddress,
  slugCompanyPart,
} from '../address-core';

const none = () => false;

describe('reserved local parts', () => {
  it('are exactly the six the PRD names', () => {
    expect([...RESERVED_LOCAL_PARTS].sort()).toEqual(
      ['abuse', 'bounce', 'bounces', 'no-reply', 'noreply', 'postmaster'],
    );
  });

  it('are recognised whatever the case or surrounding space', () => {
    expect(isReservedLocalPart('Postmaster')).toBe(true);
    expect(isReservedLocalPart(' NOREPLY ')).toBe(true);
    expect(isReservedLocalPart('acme')).toBe(false);
  });
});

describe('slugCompanyPart', () => {
  it('keeps lowercase letters and digits only', () => {
    expect(slugCompanyPart('Acme Doors & Security, Inc.')).toBe('acmedoorssecurityinc');
  });

  it('caps the part at 40 characters', () => {
    expect(slugCompanyPart('a'.repeat(60))).toBe('a'.repeat(40));
  });

  it('gives an empty string when nothing usable survives', () => {
    expect(slugCompanyPart('!!! ---')).toBe('');
    expect(slugCompanyPart(null)).toBe('');
  });

  it('never lets a header-breaking character through', () => {
    expect(slugCompanyPart('Acme\r\nBcc: x@evil.test')).toBe('acmebccxeviltest');
  });
});

describe('checkCompanyPart', () => {
  it('accepts a free, well-formed part', () => {
    expect(checkCompanyPart('acme', none)).toEqual({ ok: true, part: 'acme' });
  });

  it('lowercases what it is given', () => {
    expect(checkCompanyPart('Acme', none)).toEqual({ ok: true, part: 'acme' });
  });

  it('refuses every reserved part, as a company part', () => {
    for (const reserved of RESERVED_LOCAL_PARTS) {
      expect(checkCompanyPart(reserved, none), reserved).toEqual({ ok: false, reason: 'reserved' });
    }
  });

  it('refuses a part that any company already holds', () => {
    expect(checkCompanyPart('acme', (p) => p === 'acme')).toEqual({ ok: false, reason: 'taken' });
  });

  it('refuses a malformed part', () => {
    for (const bad of ['', 'ac me', 'ac.me', 'ac@me', 'a'.repeat(41)]) {
      expect(checkCompanyPart(bad, none), bad).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('answers reserved before taken, so a reserved part never reads as someone else’s', () => {
    expect(checkCompanyPart('noreply', () => true)).toEqual({ ok: false, reason: 'reserved' });
  });
});

describe('nextFreeCompanyPart', () => {
  it('returns the wanted part when it is free', () => {
    expect(nextFreeCompanyPart('acme', none)).toBe('acme');
  });

  it('adds a number to a taken part, taking the first free variant', () => {
    const taken = new Set(['acme', 'acme2']);
    expect(nextFreeCompanyPart('acme', (p) => taken.has(p))).toBe('acme3');
  });

  it('keeps the whole part inside 40 characters when a number is added', () => {
    const long = 'a'.repeat(40);
    const taken = new Set([long]);
    const next = nextFreeCompanyPart(long, (p) => taken.has(p));
    expect(next).toBe('a'.repeat(39) + '2');
    expect(next).toHaveLength(40);
  });

  it('gives a neutral generated part to a reserved or empty one', () => {
    expect(nextFreeCompanyPart('noreply', none)).toBe('company1');
    expect(nextFreeCompanyPart('', none)).toBe('company1');
    const taken = new Set(['company1', 'company2']);
    expect(nextFreeCompanyPart('postmaster', (p) => taken.has(p))).toBe('company3');
  });

  it('never returns a reserved part, even as a variant', () => {
    for (const wanted of ['acme', 'noreply', '']) {
      expect(isReservedLocalPart(nextFreeCompanyPart(wanted, none))).toBe(false);
    }
  });
});

describe('addresses are only on the environment’s own domain', () => {
  it('builds local@domain in lowercase', () => {
    expect(buildMailboxAddress('Acme', 'staging.mail.test.com')).toBe('acme@staging.mail.test.com');
  });

  it('parses an address on its own domain back to the local part', () => {
    expect(parseMailboxAddress('ACME@Staging.Mail.Test.com', 'staging.mail.test.com')).toBe('acme');
  });

  it('refuses an address on any other domain, including the other environment’s', () => {
    expect(parseMailboxAddress('acme@mail.test.com', 'staging.mail.test.com')).toBeNull();
    expect(parseMailboxAddress('acme@evil.test', 'staging.mail.test.com')).toBeNull();
  });

  it('refuses something that is not a bare address', () => {
    for (const bad of ['acme', '@staging.mail.test.com', 'Acme <acme@staging.mail.test.com>', 'a b@staging.mail.test.com']) {
      expect(parseMailboxAddress(bad, 'staging.mail.test.com'), bad).toBeNull();
    }
  });

  it('refuses to build an address on an empty domain', () => {
    expect(() => buildMailboxAddress('acme', '')).toThrow();
  });
});

describe('mailboxDomainFrom: the environment’s own mailbox domain', () => {
  it('is the MAILBOX_DOMAIN setting when there is one, lowercased', () => {
    expect(
      mailboxDomainFrom({ MAILBOX_DOMAIN: ' Staging.Mail.Test.com ', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' }),
    ).toBe('staging.mail.test.com');
  });

  it('is the sending domain’s own domain when MAILBOX_DOMAIN is not set', () => {
    expect(mailboxDomainFrom({ EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' })).toBe('mail.test.com');
    expect(mailboxDomainFrom({ MAILBOX_DOMAIN: '', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com' })).toBe('mail.test.com');
  });

  it('is empty when the sending address is a full identity rather than a bare address', () => {
    expect(mailboxDomainFrom({ EMAIL_FROM_BUSINESS: 'Alpha <no-reply@mail.test.com>' })).toBe('');
    expect(mailboxDomainFrom({})).toBe('');
  });
});

describe('the keyed hash a purged address is kept as', () => {
  // Worked values from the command line: printf %s 'jane.smith.acme' | openssl dgst -sha256 -hmac <key>
  const KEY = 'unit-test-key-0123456789abcdef0123';
  const OTHER_KEY = 'another-key-0123456789abcdef012345';

  it('is the HMAC-SHA256 of the lowercase local part under the key, behind a marker that is not a legal address', () => {
    expect(PURGED_ADDRESS_PREFIX).toBe('purged:');
    expect(hashLocalPart('jane.smith.acme', KEY)).toBe(
      'purged:1fd085255397296aa68f9440e6a22eb61b7a5cc8a63cfb10c799f5b3c730c653',
    );
    expect(hashLocalPart('jane.smith.acme', OTHER_KEY)).toBe(
      'purged:052b903ef51abe777f9f991db805aa8f36b1352736b8f89d23b3eade3f9fe64f',
    );
  });

  it('ignores case and surrounding space, so "Jane.Smith.Acme " is the same address', () => {
    expect(hashLocalPart(' Jane.Smith.ACME ', KEY)).toBe(hashLocalPart('jane.smith.acme', KEY));
  });

  it('never contains the address, and cannot be parsed as one', () => {
    const hashed = hashLocalPart('jane.smith.acme', KEY);
    expect(hashed).not.toContain('jane');
    expect(parseMailboxAddress(`${hashed}@mail.test.com`, 'mail.test.com')).toBeNull();
  });

  it('refuses an empty key: no key means no hash, never a plain fallback', () => {
    expect(() => hashLocalPart('jane.smith.acme', '')).toThrow(/key/i);
  });
});
