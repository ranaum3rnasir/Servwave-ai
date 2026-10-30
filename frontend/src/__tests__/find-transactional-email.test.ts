/**
 * Email slice 5 — findTransactionalEmail, the pure correlation function
 * behind the Estimate/Invoice pages' delivery-fact lookups. See its doc
 * comment (lib/api/jobCommunications.ts) for why a subject-prefix match is
 * the correlation, not a real FK.
 */
import { describe, it, expect } from 'vitest';
import { findTransactionalEmail } from '@/lib/api/jobCommunications';
import type { CommItem } from '@/lib/api/jobCommunications';

function item(overrides: Partial<CommItem> = {}): CommItem {
  return {
    id: 'x',
    channel: 'email',
    direction: 'out',
    who: 'Jane Doe',
    title: 'Estimate E00042 from ServWave',
    preview: '',
    at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('findTransactionalEmail', () => {
  it('returns undefined when items is undefined', () => {
    expect(findTransactionalEmail(undefined, 'Estimate E00042')).toBeUndefined();
  });

  it('returns undefined when nothing matches the prefix', () => {
    expect(findTransactionalEmail([item({ title: 'Estimate E00099 from ServWave' })], 'Estimate E00042')).toBeUndefined();
  });

  it('ignores non-email channels', () => {
    const call = item({ channel: 'call', title: 'Estimate E00042 from ServWave', direction: 'out' });
    expect(findTransactionalEmail([call], 'Estimate E00042')).toBeUndefined();
  });

  // Slice 6 - a HAND-LOGGED email can now exist, and this function's answer is used to render a
  // delivery status and a bounce banner on the Estimate and Invoice pages. Those are claims about
  // what ServWave's own mail transport did; a record somebody typed up about an email they sent
  // from Outlook has no such provenance. The title format a logged entry actually carries
  // ("Outbound email · <subject>") would not match this prefix anyway - which is precisely why
  // the guard is on provenance and not on the title.
  it('ignores a hand-logged email, whatever its title (it is not a platform send)', () => {
    const logged = item({ manuallyLogged: true, title: 'Estimate E00042 from ServWave' });
    expect(findTransactionalEmail([logged], 'Estimate E00042')).toBeUndefined();
  });

  // ORDER MATTERS HERE, and getting it wrong makes this test a placebo. The function returns the
  // LAST match, so with the hand-logged entry FIRST it answers `platform` whether or not the
  // provenance guard exists - which is what this test used to do, and it stayed green through a
  // mutation that deleted the guard outright. The hand-logged one therefore goes LAST: an
  // unguarded implementation returns it, a guarded one skips past it to the platform send.
  it('still finds the platform send when a hand-logged one is the most recent row', () => {
    const platform = item({ id: 'platform' });
    const logged = item({ id: 'logged', manuallyLogged: true });
    expect(findTransactionalEmail([platform, logged], 'Estimate E00042')).toBe(platform);
  });

  it('ignores inbound email (only an outbound send is a delivery fact worth surfacing)', () => {
    const inbound = item({ direction: 'in' });
    expect(findTransactionalEmail([inbound], 'Estimate E00042')).toBeUndefined();
  });

  it('matches a subject that starts with, but is not exactly, the prefix', () => {
    const match = item({ title: 'Estimate E00042 — Deposit Required' });
    expect(findTransactionalEmail([match], 'Estimate E00042')).toBe(match);
  });

  it('does not match a different, longer estimate number sharing a common prefix (E00042 vs E000420)', () => {
    // A naive startsWith would false-positive here - "Estimate E00042" is a
    // string-prefix of "Estimate E000420 from ServWave". The boundary check
    // (next char must be a space or end-of-string, never a digit) rejects it.
    const other = item({ title: 'Estimate E000420 from ServWave' });
    expect(findTransactionalEmail([other], 'Estimate E00042')).toBeUndefined();
  });

  it('does not match a sibling REVISION of the same estimate (E00042 vs E00042-2)', () => {
    // Real collision risk: EstimateTabs lets a lead carry several sibling
    // estimates/revisions on one lead (E00042, E00042-2, ...), each sent
    // separately. A bounce on the -2 revision's send must never paint the
    // banner on the original E00042's own page.
    const revision = item({ title: 'Estimate E00042-2 from ServWave', deliveryStatus: 'BOUNCED', bounceKind: 'HARD' });
    expect(findTransactionalEmail([revision], 'Estimate E00042')).toBeUndefined();
  });

  it('matches a bare subject with no trailing text at all (Invoice with no org name on file)', () => {
    // sendInvoiceEmail's subject degrades to a BARE `Invoice ${invoiceNumber}`
    // when the org has no name set - end-of-string is a valid boundary too.
    const bare = item({ title: 'Invoice I00042' });
    expect(findTransactionalEmail([bare], 'Invoice I00042')).toBe(bare);
  });

  it('returns the LAST match when several sends share the same subject prefix (most recent send/resend wins)', () => {
    const first = item({ id: 'first', deliveryStatus: 'BOUNCED' });
    const second = item({ id: 'second', deliveryStatus: 'DELIVERED' });
    // Caller passes items in ascending (oldest-first) order, same as the comm endpoints.
    expect(findTransactionalEmail([first, second], 'Estimate E00042')).toBe(second);
  });
});
