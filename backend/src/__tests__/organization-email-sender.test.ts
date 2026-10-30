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

// The register is the one place that decides whether a company part is free and moves the main
// address; its own rules are proved against a real database in mailbox-register-db.test.ts. Here the
// route is checked for what it asks of the register and how it answers.
const { changeCompanyPart } = vi.hoisted(() => ({ changeCompanyPart: vi.fn() }));
vi.mock('../lib/mailbox/register', () => ({ changeCompanyPart }));

const ORG_ID = '00000000-0000-0000-0000-0000000000a1';

/** `as` must name the SAME user mockAuthAs was given - authHeader() defaults to
 *  the admin token, so sending it while mocking a technician tests nothing. */
const patch = (body: Record<string, unknown>, as: 'admin' | 'technician' | 'dispatcher' = 'admin') =>
  request(app).patch('/api/organization/email-sender').set(authHeader(as)).send(body);

const changed = (part: string, derivedFromName = false) => ({
  ok: true as const,
  part,
  address: `${part}@mail.test.com`,
  derivedFromName,
  previousPart: 'before',
  changed: true,
  usersMoved: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  changeCompanyPart.mockResolvedValue(changed('service'));
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

    expect(changeCompanyPart).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'service', { dryRun: false });
  });

  it('passes a dry run down as a dry run, and still runs the same validation first', async () => {
    const ok = await patch({ local_part: 'Service', dry_run: true });
    expect(ok.status).toBe(200);
    expect(changeCompanyPart).toHaveBeenCalledWith(expect.anything(), expect.any(String), 'service', { dryRun: true });

    changeCompanyPart.mockClear();
    const reserved = await patch({ local_part: 'postmaster', dry_run: true });
    expect(reserved.status).toBe(400);
    expect(changeCompanyPart).not.toHaveBeenCalled();
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
    const res = await patch({ local_part: 'service@example-company.test' });

    expect(res.status).toBe(400);
  });

  it('rejects the reserved names a mail domain owes to the internet', async () => {
    // RFC 2142 expects postmaster/abuse to mean something specific on a domain,
    // and `no-reply` is the fallback when a slug comes out empty - an org that
    // claimed it would collide with every unnamed org at once.
    for (const reserved of ['postmaster', 'abuse', 'bounce', 'no-reply', 'noreply']) {
      const res = await patch({ local_part: reserved });
      expect(res.status, reserved).toBe(400);
      expect(JSON.stringify(res.body.details), reserved).toContain('This address is reserved.');
    }
    expect(changeCompanyPart).not.toHaveBeenCalled();
  });

  it('goes back to the name-derived part when sent an empty value', async () => {
    changeCompanyPart.mockResolvedValue(changed('exampledoorssecurity', true));

    const res = await patch({ local_part: '' });

    expect(res.status).toBe(200);
    expect(changeCompanyPart).toHaveBeenCalledWith(expect.anything(), expect.any(String), null, { dryRun: false });
    expect(res.body).toMatchObject({ local_part: 'exampledoorssecurity', local_part_is_custom: false });
  });

  it('answers with the part, whether it is the admin own, and the fixed domain', async () => {
    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ local_part: 'service', local_part_is_custom: true, sender_domain: 'mail.test.com' });
  });
});

describe('PATCH /api/organization/email-sender - uniqueness', () => {
  it('409s when the register says another company holds that address, without naming anyone', async () => {
    changeCompanyPart.mockResolvedValue({ ok: false, reason: 'taken' });

    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'This email address is already in use. Choose a different one.',
      code: 'LOCAL_PART_TAKEN',
    });
  });

  it('refuses a reserved part the register reports, in the page’s own words', async () => {
    changeCompanyPart.mockResolvedValue({ ok: false, reason: 'reserved' });

    const res = await patch({ local_part: 'service' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This address is reserved.');
  });

  it('asks the register about the org on the token, never one named in the request', async () => {
    await patch({ local_part: 'service' });

    expect(changeCompanyPart).toHaveBeenCalledWith(
      expect.anything(),
      '00000000-0000-0000-0000-000000000001',
      'service',
      { dryRun: false },
    );
  });

  it('survives the database losing the race and raising a unique violation', async () => {
    // A writer outside the register's lock can still lose to the unique index; that has to land as the
    // same clean 409 rather than a 500.
    changeCompanyPart.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

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
    expect(changeCompanyPart).not.toHaveBeenCalled();
  });
});
