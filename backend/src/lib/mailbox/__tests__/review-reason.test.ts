import { describe, it, expect } from 'vitest';
import { reviewReasonOf } from '../review-reason';

describe('reviewReasonOf', () => {
  it('delivers an ordinary message on a mailbox address or an accepted reply address, whatever the verdict but a failure', () => {
    for (const auth of ['PASS', 'NO_POLICY', 'UNAVAILABLE'] as const) {
      expect(reviewReasonOf({ auth, automatic: false })).toBeNull();
      expect(reviewReasonOf({ auth, automatic: false, replyAddress: 'accepted' })).toBeNull();
    }
  });

  it('names a failed authentication first, whatever else is true of the message', () => {
    expect(reviewReasonOf({ auth: 'FAIL', automatic: false })).toBe('failed_authentication');
    expect(reviewReasonOf({ auth: 'FAIL', automatic: true, replyAddress: 'sender_refused' })).toBe('failed_authentication');
    expect(reviewReasonOf({ auth: 'FAIL', automatic: false, replyAddress: 'accepted' })).toBe('failed_authentication');
  });

  it('names automatic mail before what the reply address said', () => {
    expect(reviewReasonOf({ auth: 'PASS', automatic: true })).toBe('automatic');
    expect(reviewReasonOf({ auth: 'PASS', automatic: true, replyAddress: 'accepted' })).toBe('automatic');
    expect(reviewReasonOf({ auth: 'UNAVAILABLE', automatic: true, replyAddress: 'no_longer_resolves' })).toBe('automatic');
  });

  it('names the reply address\'s own verdict last', () => {
    expect(reviewReasonOf({ auth: 'PASS', automatic: false, replyAddress: 'sender_refused' })).toBe('sender_mismatch');
    expect(reviewReasonOf({ auth: 'PASS', automatic: false, replyAddress: 'no_longer_resolves' })).toBe('unknown_reply');
  });
});
