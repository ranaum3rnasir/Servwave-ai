// The local part of an org's From address (`alphadoorssecurity@mail.servwave.com`)
// has always been DERIVED from the company name with no way to change it. An
// org that would rather be `service@` or `office@` had no control at all.
//
// So `organizations.email_sender_local_part` overrides it. NULL means "derive
// from the name", which is both the default and the pre-existing behaviour -
// deliberately not backfilled, so renaming a company still updates its sending
// address exactly as it does today, and only an org that opts in gets a frozen
// value.
//
// The DOMAIN half is never touched. Sending stays on EMAIL_FROM_BUSINESS for
// every org; this is the string before the `@` and nothing else.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.unmock('../lib/email');

let effectiveSenderLocalPart: (
  orgName: string | null | undefined,
  explicit: string | null | undefined,
) => string;

beforeAll(async () => {
  ({ effectiveSenderLocalPart } = await vi.importActual<typeof import('../lib/email')>('../lib/email'));
});

describe('effectiveSenderLocalPart', () => {
  it('derives from the company name when the org has set nothing', () => {
    expect(effectiveSenderLocalPart('Alpha Doors & Security', null)).toBe('alphadoorssecurity');
  });

  it('uses the org own value when it has set one', () => {
    expect(effectiveSenderLocalPart('Alpha Doors & Security', 'service')).toBe('service');
  });

  it('treats undefined the same as null - both mean derive', () => {
    // The column is nullable and a `select` that omits it yields undefined, so
    // the two have to behave identically or the address would flip.
    expect(effectiveSenderLocalPart('Alpha Doors & Security', undefined)).toBe('alphadoorssecurity');
  });

  it('treats an empty or whitespace-only override as no override', () => {
    // Clearing the field must return the org to the derived default rather
    // than producing `@mail.servwave.com` with nothing in front of it.
    expect(effectiveSenderLocalPart('Alpha Doors', '')).toBe('alphadoors');
    expect(effectiveSenderLocalPart('Alpha Doors', '   ')).toBe('alphadoors');
  });

  it('still falls back to no-reply when there is neither a name nor an override', () => {
    expect(effectiveSenderLocalPart(null, null)).toBe('no-reply');
  });
});
