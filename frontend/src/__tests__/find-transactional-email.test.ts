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
