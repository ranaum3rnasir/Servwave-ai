// PATCH /api/organization/email-sender - the org's chosen local part for its
// business From address. The domain half is never sent, never accepted and
// never changes: sending stays on the shared EMAIL_FROM_BUSINESS domain for
// every org, and this endpoint governs the string before the `@` only.
//
// ADMIN-only, matching the custom-domain endpoints it supersedes: this changes
// the address every customer of the org sees, so it is an org-wide identity
// change rather than a per-user preference.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader } from './helpers';
import { prisma } from '../lib/prisma';

const ORG_ID = '00000000-0000-0000-0000-0000000000a1';

/** `as` must name the SAME user mockAuthAs was given - authHeader() defaults to
 *  the admin token, so sending it while mocking a technician tests nothing. */
const patch = (body: Record<string, unknown>, as: 'admin' | 'technician' | 'dispatcher' = 'admin') =>
  request(app).patch('/api/organization/email-sender').set(authHeader(as)).send(body);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  (prisma.organization.update as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: ORG_ID,
    name: 'Alpha Doors & Security',
    email_sender_local_part: 'service',
    email_sending_enabled: true,
  });
  (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: ORG_ID,
    name: 'Alpha Doors & Security',
    email_sender_local_part: 'service',
    email_sending_enabled: true,
  });
  (prisma.organization.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

describe('PATCH /api/organization/email-sender - validation', () => {
  it('accepts a plain lowercase local part', async () => {
    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(200);
  });

  it('lowercases what the admin typed rather than rejecting it', async () => {
    // An address is case-insensitive in practice; bouncing "Service" would be
    // pedantry, and storing it uppercased would make the unique index miss.
    await patch({ local_part: 'Service' });

    const arg = (prisma.organization.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.data.email_sender_local_part).toBe('service');
  });

  it('rejects characters an address local part cannot carry', async () => {
    for (const bad of ['ser vice', 'ser@vice', 'ser/vice', 'servicé']) {
      const res = await patch({ local_part: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it('rejects a value longer than the address cap', async () => {
    const res = await patch({ local_part: 'a'.repeat(41) });

    expect(res.status).toBe(400);
  });

  it('rejects a full email address - the domain is not the org to choose', async () => {
    // The single most likely thing an admin types into a field like this.
    const res = await patch({ local_part: 'service@alphadoors.com' });

    expect(res.status).toBe(400);
  });

  it('rejects the reserved names a mail domain owes to the internet', async () => {
    // RFC 2142 expects postmaster/abuse to mean something specific on a domain,
    // and `no-reply` is the fallback when a slug comes out empty - an org that
    // claimed it would collide with every unnamed org at once.
    for (const reserved of ['postmaster', 'abuse', 'bounce', 'no-reply', 'noreply']) {
      const res = await patch({ local_part: reserved });
      expect(res.status, reserved).toBe(400);
    }
  });

  it('clears the override when sent an empty value, returning to the derived name', async () => {
    (prisma.organization.update as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: ORG_ID,
      name: 'Alpha Doors & Security',
      email_sender_local_part: null,
      email_sending_enabled: true,
    });

    const res = await patch({ local_part: '' });

    expect(res.status).toBe(200);
    const arg = (prisma.organization.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.data.email_sender_local_part).toBeNull();
  });
});

describe('PATCH /api/organization/email-sender - uniqueness', () => {
  it('409s when another org already sends from that address', async () => {
    (prisma.organization.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'other-org' });

    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCAL_PART_TAKEN');
  });

  it('does not treat the org own current value as a conflict', async () => {
    // Re-saving an unchanged form must not fail; the lookup excludes self.
    await patch({ local_part: 'service' });

    const where = (prisma.organization.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]![0].where;
    expect(where.id).toEqual({ not: expect.any(String) });
  });

  it('survives the database losing the race and raising a unique violation', async () => {
    // Two admins of two orgs can pass the pre-check simultaneously; the index
    // is the real guarantee, so P2002 has to land as the same clean 409 rather
    // than a 500.
    (prisma.organization.update as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LOCAL_PART_TAKEN');
  });
});

describe('PATCH /api/organization/email-sender - authorization', () => {
  it('is refused for a technician', async () => {
    mockAuthAs('technician');

    const res = await patch({ local_part: 'service' }, 'technician');

    expect(res.status).toBe(403);
  });

  it('is refused for a dispatcher, who runs ops but not org identity', async () => {
    mockAuthAs('dispatcher');

    const res = await patch({ local_part: 'service' }, 'dispatcher');

    expect(res.status).toBe(403);
  });

  it('refuses an organization_id smuggled into the body', async () => {
    // The schema is .strict(), so a caller cannot even name another org - the
    // request is rejected outright rather than silently ignoring the field.
    const res = await patch({ local_part: 'service', organization_id: 'someone-else' });

    expect(res.status).toBe(400);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('writes to the org on the token, with no id anywhere in the path', async () => {
    await patch({ local_part: 'service' });

    const arg = (prisma.organization.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(arg.where.id).toBe('00000000-0000-0000-0000-000000000001');
  });
});
