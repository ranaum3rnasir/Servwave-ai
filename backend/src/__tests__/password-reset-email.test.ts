/**
 * sendPasswordResetEmail (password reset spec §5.1 step 3, slice 04).
 *
 * Seam: the message handed to the mail provider (mocked at the SDK boundary) and the boolean the
 * caller gets back. The link and its token are generated per run and never appear in a log line.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { randomBytes } from 'crypto';

const { sent, nextResult } = vi.hoisted(() => ({
  sent: [] as Array<Record<string, string>>,
  nextResult: { value: null as null | { data: unknown; error: unknown } },
}));

vi.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    EMAIL_FROM: 'Platform Sender <no-reply@test.com>',
    RESEND_API_KEY: 're_test_key',
    MAILBOX_DOMAIN: 'mail.test.com',
    FRONTEND_URL: 'http://localhost:5173',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: vi.fn(async (payload: Record<string, string>) => {
        sent.push(payload);
        return nextResult.value ?? { data: { id: 'mock-id' }, error: null };
      }),
    };
  },
}));

import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

let email: typeof import('../lib/email');
beforeAll(async () => {
  email = await vi.importActual<typeof import('../lib/email')>('../lib/email');
});

const ORG_ID = '00000000-0000-0000-0000-000000000001';
let resetUrl: string;
let token: string;

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  nextResult.value = null;
  token = randomBytes(24).toString('hex');
  resetUrl = `http://localhost:5173/reset-password?token=${token}`;
  (prisma.organization.findUnique as Mock).mockResolvedValue({
    name: 'Harbor Plumbing',
    logo_url: null,
    brand_color: '#123456',
  });
});

const send = (over: Partial<Parameters<typeof email.sendPasswordResetEmail>[0]> = {}) =>
  email.sendPasswordResetEmail({ to: 'dana@example.test', firstName: 'Dana', resetUrl, organizationId: ORG_ID, ...over });

/** Every string the logger was handed, flattened. */
const logged = () =>
  JSON.stringify([
    (logger.info as Mock).mock.calls,
    (logger.warn as Mock).mock.calls,
    (logger.error as Mock).mock.calls,
    (logger.debug as Mock).mock.calls,
  ]);

describe('sendPasswordResetEmail', () => {
  it('sends the ServWave reset email with the copy from the spec and a working button', async () => {
    expect(await send()).toBe(true);

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.to).toBe('dana@example.test');
    expect(msg.subject).toBe('Reset your ServWave password');
    expect(msg.html).toContain('Hi Dana, we received a request to reset the password for dana@example.test.');
    expect(msg.html).toContain(`href="${resetUrl}"`);
    expect(msg.html).toContain('Reset password');
    expect(msg.html).toContain(
      'This link expires in 1 hour and can be used once. If you didn&#39;t ask for this, you can ignore this email — your password won&#39;t change.',
    );
    expect(msg.text).toContain(resetUrl);
    expect(msg.text).toContain('This link expires in 1 hour and can be used once.');
  });

  it('greets with a plain "Hi," when the user has no first name', async () => {
    await send({ firstName: '' });
    const msg = sent[0];
    expect(msg.html).toContain('Hi, we received a request to reset the password for dana@example.test.');
    expect(msg.text).toMatch(/^Hi, we received a request to reset the password for dana@example\.test\./);
    expect(msg.html).not.toContain('Hi ,');
    expect(msg.text).not.toContain('Hi ,');
  });

  it("goes out under the org's sender name, from the platform address", async () => {
    await send();
    expect(sent[0].from).toBe('"Harbor Plumbing" <no-reply@test.com>');
  });

  it('escapes the names it puts in the email', async () => {
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      name: 'Acme <img src=x onerror=alert(1)>',
      logo_url: null,
      brand_color: '#123456',
    });
    await send({ firstName: '<script>alert(2)</script>' });

    const html = sent[0].html;
    expect(html).not.toContain('<script>alert(2)');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(2)&lt;/script&gt;');
  });

  it('names no vendor anywhere in the message', async () => {
    await send();
    const msg = sent[0];
    for (const field of [msg.from, msg.subject, msg.html, msg.text]) {
      expect(field).not.toMatch(/supabase|gotrue|resend|render\.com|vercel/i);
    }
  });

  it('reports false when the provider rejects the message, without logging the link', async () => {
    nextResult.value = { data: null, error: { name: 'validation_error', message: 'rejected', statusCode: 422 } };

    expect(await send()).toBe(false);
    expect(logged()).not.toContain(token);
  });

  it('reports false when the provider call throws, without logging the link', async () => {
    (email.resend!.emails.send as unknown as Mock).mockRejectedValueOnce(new Error(`socket closed for ${resetUrl}`));

    expect(await send()).toBe(false);
    expect(logged()).not.toContain(token);
  });

  it('never writes the link or its token to a log line on success', async () => {
    await send();
    expect(logged()).not.toContain(token);
  });
});
