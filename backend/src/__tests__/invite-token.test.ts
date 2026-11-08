import { describe, it, expect } from 'vitest';
import { signInviteToken, verifyInviteToken } from '../lib/invite-token';

const UID = '11111111-1111-1111-1111-111111111111';
const EMAIL = 'invitee@example.com';

describe('invite-token', () => {
  it('round-trips a valid token', () => {
    const token = signInviteToken(UID, EMAIL);
    const payload = verifyInviteToken(token);
    expect(payload).toMatchObject({ uid: UID, email: EMAIL });
    expect(typeof payload!.exp).toBe('number');
  });

  it('rejects a tampered payload', () => {
    const token = signInviteToken(UID, EMAIL);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ uid: UID, email: 'attacker@evil.com', exp: 9999999999 })).toString('base64url');
    expect(verifyInviteToken(`${forged}.${sig}`)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyInviteToken('garbage')).toBeNull();
    expect(verifyInviteToken('a.b.c')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signInviteToken(UID, EMAIL, -10); // already expired
    expect(verifyInviteToken(token)).toBeNull();
  });
});
