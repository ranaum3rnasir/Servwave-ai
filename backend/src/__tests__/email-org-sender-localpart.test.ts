// The shared sending address used to be a flat `no-reply@mail.servwave.com`
// for every org on the platform, so a recipient's inbox showed the display name
// doing all the work and an address that named nobody. The local part now
// carries the org, giving `northwindservices@mail.servwave.com`.
//
// Only the LOCAL PART changes, and only on the shared domain. An org with its
// own verified domain already has its identity in the domain itself, so it
// keeps `no-reply@theirdomain.com` - the address a customer would expect from
// a company writing on its own letterhead.
//
// The domain half stays whatever EMAIL_FROM_BUSINESS carries, so moving the
// platform to a different sending domain stays a config change, not a code one.
import { describe, it, expect, vi, beforeAll } from 'vitest';

// setup.ts mocks lib/email for every controller test. This one exercises the
// real derivation, so it opts out.
vi.unmock('../lib/email');

let orgSenderLocalPart: (name: string | null | undefined) => string;

beforeAll(async () => {
  ({ orgSenderLocalPart } = await vi.importActual<typeof import('../lib/email')>('../lib/email'));
});

describe('orgSenderLocalPart', () => {
  it('slugs an ordinary company name', () => {
    expect(orgSenderLocalPart('Northwind Services')).toBe('northwindservices');
  });

  it('drops punctuation an address cannot carry', () => {
    expect(orgSenderLocalPart('Northwind Services, Inc.')).toBe('northwindservicesinc');
  });

  it('keeps digits, which are legal and often part of the name', () => {
    expect(orgSenderLocalPart('247 Plumbing')).toBe('247plumbing');
  });

  it('transliterates nothing - non-ASCII is dropped, not mangled', () => {
    // A local part is ASCII here by construction. Guessing at a romanization
    // would put a name on the envelope the org never chose.
    expect(orgSenderLocalPart('Grüne Löwen')).toBe('grnelwen');
  });

  it('caps the length so the address stays sane', () => {
    const slug = orgSenderLocalPart('A'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(40);
  });

  it('falls back to no-reply when nothing usable survives', () => {
    // An org named only in punctuation, or not named at all, must still have a
    // deliverable address - never an empty local part.
    expect(orgSenderLocalPart('!!!')).toBe('no-reply');
    expect(orgSenderLocalPart('')).toBe('no-reply');
    expect(orgSenderLocalPart(null)).toBe('no-reply');
    expect(orgSenderLocalPart(undefined)).toBe('no-reply');
  });

  it('leaves an org name that is already an address alone in the local part', () => {
    // Nothing special - just documents that '@' is not privileged input here.
    expect(orgSenderLocalPart('ops@acme.com')).toBe('opsacmecom');
  });

  it('never emits a character that would break the header', () => {
    // The org name is user-controlled. A CRLF in a From header is header
    // injection, which sanitizeDisplayName already guards for the display half;
    // the address half must be just as strict.
    expect(orgSenderLocalPart('evil\r\nBcc: attacker@example.com')).toBe('evilbccattackerexamplecom');
  });
});
