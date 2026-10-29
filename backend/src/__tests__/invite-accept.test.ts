import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { signInviteToken } from '../lib/invite-token';
import { ALPHA_ORG_ID } from './helpers';

const mockPrisma = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  termsAcceptance: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
};
const mockSupabase = supabaseAdmin as unknown as {
  auth: {
    signInWithPassword: ReturnType<typeof vi.fn>;
    admin: { createUser: ReturnType<typeof vi.fn> };
  };
};

const UID = '00000000-0000-0000-0000-0000000007aa';
const EMAIL = 'invitee@test.com';
const invitedRow = {
  id: UID, email: EMAIL, first_name: 'In', last_name: 'Vitee', role: 'TECHNICIAN',
  is_active: true, organization_id: ALPHA_ORG_ID, department_id: null, location_id: null,
};

beforeEach(() => vi.clearAllMocks());

describe('POST /api/auth/invite', () => {
  // Token moved from the query string to the POST body so it can never be
  // captured by the request logger / proxy access logs (single-use secret).
  it('returns the invitee email + first name for a valid token', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/invite').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: EMAIL, first_name: 'In' });
  });

  it('returns 400 for a bad token', async () => {
    const res = await request(app).post('/api/auth/invite').send({ token: 'garbage' });
    expect(res.status).toBe(400);
  });

  // The page PREFILLS its phone box from this response. Without the number the
  // admin already typed on the invite card, a hire who leaves the box alone
  // would be submitting a blank over a value that exists.
  it('returns the stored phone and extension so the page can prefill', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: '+15551112222', phone_ext: '45' });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/invite').send({ token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ phone: '+15551112222', phone_ext: '45' });
  });

  it('returns a null phone for an invite the admin left blank', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: null, phone_ext: null });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/invite').send({ token });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBeNull();
    expect(res.body.phone_ext).toBeNull();
  });
});

describe('POST /api/auth/accept-invite', () => {
  it('creates a confirmed Supabase account with the chosen password', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const args = mockSupabase.auth.admin.createUser.mock.calls[0][0];
    expect(args).toMatchObject({ email: EMAIL, password: 'sup3rsecret', email_confirm: true });
  });

  it('rejects a short password with 400', async () => {
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'short', accepted_terms: true });
    expect(res.status).toBe(400);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it('returns 409 when the account already exists (e.g. they used Google first)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: null }, error: { code: 'email_exists', message: 'A user with this email already exists' } });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(409);
  });

  it('returns 400 for an invalid token', async () => {
    const res = await request(app).post('/api/auth/accept-invite').send({ token: 'nope', password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the invited user no longer exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('rejects when the terms are not accepted (400, no account, no record)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret' }); // accepted_terms omitted
    expect(res.status).toBe(400);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('records a terms_acceptances row on success', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.termsAcceptance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      user_id: UID,
      user_email: EMAIL,
      organization_id: ALPHA_ORG_ID,
      terms_version: '2026-06-30',
      terms_url: 'https://www.servwave.com/terms/',
      privacy_url: 'https://www.servwave.com/privacy/',
      context: 'invite_acceptance',
    });
  });

  it('does not write a second terms row if one already exists (Google recorded it first)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'existing-from-google' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  // Spec C slice 3: the one capture surface a new hire is guaranteed to see.
  it('persists a submitted phone on the user row, normalized to E.164', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true, phone: '(555) 111-2222' });

    expect(res.status).toBe(200);
    // The masked display form the box shows is NOT what the column gets - the
    // shared userPhoneField transform is what makes one spelling arrive here.
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update.mock.calls[0][0]).toEqual({
      where: { id: UID },
      data: { phone: '+15551112222' },
    });
  });

  // THE data-loss guard. `inviteUser` persists the number the admin typed on the
  // invite card, so "blank means null" here would destroy exactly the data this
  // capture exists to collect. Blank leaves the column ALONE.
  it.each([
    ['omitted', {}],
    ['empty', { phone: '' }],
    ['whitespace only', { phone: '   ' }],
    ['explicitly null', { phone: null }],
  ])('leaves the stored phone untouched when the box is %s', async (_label, body) => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: '+15551112222' });
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true, ...body });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // The same blank on a hire nobody supplied a number for: acceptance completes
  // and they simply end up with no number - not an error, not a write.
  it('completes acceptance for a hire with no number who submits blank', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: null });
    mockSupabase.auth.admin.createUser.mockResolvedValue({ data: { user: { id: 'supa-new' } }, error: null });
    // Explicit: `vi.clearAllMocks()` clears CALLS, not implementations, so an
    // earlier test's `findFirst -> existing` would otherwise still be in force.
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-1' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true, phone: '' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
  });

  // An unusable number never half-completes: no login, no consent row, no write.
  it('refuses an unusable phone and leaves the invite unconsumed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'sup3rsecret', accepted_terms: true, phone: '555' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enter a 10-digit US or Canadian phone number');
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // Both wrong at once. The phone is OPTIONAL and the password is REQUIRED, so
  // naming only the phone sends the hire to fix the field that was never
  // blocking and hands them the password error on the NEXT submit. One alert,
  // both problems, blocking one first.
  it('names the password before the phone when both are invalid', async () => {
    // Pinned, not inherited: clearAllMocks resets calls, not implementations.
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite')
      .send({ token, password: 'short', accepted_terms: true, phone: '555' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'A token and a password of at least 8 characters are required. Enter a 10-digit US or Canadian phone number.',
    );
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // #607 defense-in-depth: refuse acceptance if the email is ever tied to a
  // different account, before any Supabase account is created.
  it('rejects acceptance when the email is tied to a different account (defense-in-depth)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'another-account' });
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app).post('/api/auth/accept-invite').send({ token, password: 'sup3rsecret', accepted_terms: true });
    expect(res.status).toBe(409);
    expect(mockSupabase.auth.admin.createUser).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/login (confirmed-email fallback for invited users)', () => {
  it('logs in a user whose Prisma id differs from the Supabase id, via confirmed email', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: 'supa-new', email: EMAIL, email_confirmed_at: '2026-06-12T00:00:00Z' },
        session: { access_token: 'a', refresh_token: 'r', expires_at: 123 },
      },
      error: null,
    });
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.findFirst.mockImplementation(({ where }: { where: { email?: { equals?: string } } }) =>
      where.email?.equals === EMAIL ? Promise.resolve(invitedRow) : Promise.resolve(null),
    );

    const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'sup3rsecret' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: EMAIL, organization_id: ALPHA_ORG_ID });
    expect(res.body.session.access_token).toBe('a');
  });
});

describe('POST /api/auth/accept-invite/terms (Google-path consent, no password)', () => {
  it('records a terms row (context invite_acceptance_google) and returns 200', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-g' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
    const data = mockPrisma.termsAcceptance.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      user_id: UID,
      user_email: EMAIL,
      organization_id: ALPHA_ORG_ID,
      terms_version: '2026-06-30',
      terms_url: 'https://www.servwave.com/terms/',
      privacy_url: 'https://www.servwave.com/privacy/',
      context: 'invite_acceptance_google',
    });
  });

  it('is idempotent — does not write a second row when one already exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'existing' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('rejects missing/false accepted_terms with 400 and writes no row', async () => {
    const token = signInviteToken(UID, EMAIL);
    const missing = await request(app).post('/api/auth/accept-invite/terms').send({ token });
    const explicitFalse = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: false });
    expect(missing.status).toBe(400);
    expect(explicitFalse.status).toBe(400);
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid/expired token', async () => {
    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token: 'garbage', accepted_terms: true });
    expect(res.status).toBe(400);
  });

  it('leaves the stored phone untouched when the Google path submits a blank box', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: '+15551112222' });
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-g' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true, phone: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('completes the Google path for a hire with no number who submits blank', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...invitedRow, phone: null });
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-g' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true, phone: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.termsAcceptance.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an unusable phone on the Google path and records no consent', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true, phone: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Enter a 10-digit US or Canadian phone number');
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // The same precedence on the path that is easiest to forget. Consent is the
  // blocking problem here, so it is named first and the phone follows it.
  it('names the terms before the phone when both are invalid', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: false, phone: '12345' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      'You must accept the Terms of Service and Privacy Policy to continue. Enter a 10-digit US or Canadian phone number.',
    );
    expect(mockPrisma.termsAcceptance.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  // The path most likely to be forgotten. A phone carried only on the password
  // path silently skips every invitee who signs in with Google, and the gap
  // this capture exists to close stays open for a whole class of users.
  it('persists a submitted phone, normalized, on the Google consent path', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(invitedRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    mockPrisma.termsAcceptance.create.mockResolvedValue({ id: 'ta-g' });
    const token = signInviteToken(UID, EMAIL);

    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true, phone: '555-999-8888' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.update.mock.calls[0][0]).toEqual({
      where: { id: UID },
      data: { phone: '+15559998888' },
    });
  });

  it('returns 400 when the invited user no longer exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const token = signInviteToken(UID, EMAIL);
    const res = await request(app)
      .post('/api/auth/accept-invite/terms')
      .send({ token, accepted_terms: true });
    expect(res.status).toBe(400);
  });
});
