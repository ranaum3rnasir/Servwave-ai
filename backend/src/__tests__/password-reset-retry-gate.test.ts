/**
 * The controller's own gate on the replacement token (password reset spec §5.2; conductor brief
 * §3.3): a token goes out only with a `weak_password` answer, even if the reset step were ever to
 * hand one back for some other refusal. Seam: the HTTP response, with `completePasswordReset`
 * stubbed so the outcome can be one the real function never produces. Tokens generated per run.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'crypto';

vi.mock('../lib/password-reset', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/password-reset')>()),
  completePasswordReset: vi.fn(),
}));

import app from '../app';
import { completePasswordReset } from '../lib/password-reset';
import { BREACHED_PASSWORD_MESSAGE, PASSWORD_UPDATE_FAILED_MESSAGE } from '../lib/auth-provider-errors';
import { TEST_USERS } from './helpers';

const secret = () => randomBytes(16).toString('base64url');
const user = { ...TEST_USERS.admin, is_active: true, has_login: true };
const reset = () => request(app).post('/api/auth/password/reset').send({ token: secret(), password: secret() });

let retryToken: string;

beforeEach(() => {
  vi.clearAllMocks();
  retryToken = secret();
});

describe('POST /api/auth/password/reset - who gets a replacement token', () => {
  it.each([
    ['a provider failure that is not a breached password', { status: 500, code: 'unexpected_failure', message: 'boom' }],
    ['an error with no code at all', new Error('socket hang up')],
  ])('%s never carries a token, even if one was minted', async (_label, error) => {
    (completePasswordReset as Mock).mockResolvedValue({ kind: 'rejected', error, user, retryToken });

    const res = await reset();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_UPDATE_FAILED_MESSAGE });
    expect(JSON.stringify(res.body)).not.toContain(retryToken);
  });

  it('a breached password carries the token it was given', async () => {
    (completePasswordReset as Mock).mockResolvedValue({
      kind: 'rejected',
      error: { status: 422, code: 'weak_password', message: 'weak' },
      user,
      retryToken,
    });

    const res = await reset();

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'weak_password', error: BREACHED_PASSWORD_MESSAGE, token: retryToken });
  });

  it('a breached password with nothing minted carries no token', async () => {
    (completePasswordReset as Mock).mockResolvedValue({ kind: 'rejected', error: { status: 422, code: 'weak_password' }, user });

    const res = await reset();

    expect(res.body).toEqual({ code: 'weak_password', error: BREACHED_PASSWORD_MESSAGE });
  });
});
