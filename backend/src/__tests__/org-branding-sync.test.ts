// Payments go-live slice 36 - the contractor's name, colour and logo reach the connected account's branding
// settings whenever they change, and when onboarding finishes. The processor's library is the suite-wide fake;
// everything ServWave decides (when to sync, with what) is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { updateAccountBranding, retrieveAccount } from '../lib/stripe';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

vi.mock('sharp', () => ({
  default: vi.fn().mockReturnValue({
    resize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image')),
  }),
}));

const mockBranding = vi.mocked(updateAccountBranding);
const mockRetrieve = vi.mocked(retrieveAccount);
const orgFindUnique = prisma.organization.findUnique as unknown as ReturnType<typeof vi.fn>;
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ORG = {
  id: ALPHA_ORG_ID,
  name: 'Harbor Locksmiths LLC',
  brand_color: '#0C2D3A',
  logo_url: 'https://test.supabase.co/storage/v1/object/public/test/file.jpg',
  stripe_account_id: 'acct_branding_1',
  stripe_charges_enabled: false,
  accepted_payment_methods: ['CHECK'],
};

function useOrg(overrides: Record<string, unknown> = {}) {
  const row = { ...ORG, ...overrides };
  orgFindUnique.mockResolvedValue(row);
  (prisma.organization as any).update = vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data));
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
  (prisma.$executeRaw as any).mockResolvedValue(0);
  return row;
}

afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  vi.clearAllMocks();
  mockBranding.mockResolvedValue(undefined);
  mockAuthAs('admin');
});

describe('branding sync on an organization save', () => {
  it('pushes the colour once, with the saved value and no business name', async () => {
    useOrg();
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ name: 'Harbor Locks', brand_color: '#112233' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockBranding).toHaveBeenCalledTimes(1));
    expect(mockBranding).toHaveBeenCalledWith('acct_branding_1', { primaryColor: '#112233' });
  });

  it('does not sync for a name change alone: the name is not a branding setting the platform may write', async () => {
    useOrg();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ name: 'Harbor Locks' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockBranding).not.toHaveBeenCalled();
  });

  it('does not sync when something unrelated to branding was saved', async () => {
    useOrg();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ estimate_terms: 'Net 30' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockBranding).not.toHaveBeenCalled();
  });

  it('does not sync for an organization with no payout account', async () => {
    useOrg({ stripe_account_id: null });
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ brand_color: '#112233' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(mockBranding).not.toHaveBeenCalled();
  });

  it('still saves when the processor refuses the branding', async () => {
    useOrg();
    mockBranding.mockRejectedValue(new Error('processor down'));
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ brand_color: '#112233' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockBranding).toHaveBeenCalledTimes(1));
  });

  it('logs a processor refusal at error level with the reason, and the save still succeeds', async () => {
    useOrg();
    const errorLog = vi.spyOn(logger, 'error').mockImplementation((() => logger) as never);
    mockBranding.mockRejectedValue(new Error("does not have the required permissions for the parameter 'settings'"));
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ brand_color: '#112233' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(errorLog.mock.calls[0])).toContain('required permissions');
    errorLog.mockRestore();
  });
});

describe('branding sync on a logo upload', () => {
  it('pushes the new logo bytes once, with the colour and no business name', async () => {
    useOrg();
    const res = await request(app).post('/api/organization/logo').set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockBranding).toHaveBeenCalledTimes(1));
    const [account, branding] = mockBranding.mock.calls[0]!;
    expect(account).toBe('acct_branding_1');
    expect(branding).toMatchObject({ primaryColor: '#0C2D3A' });
    expect(branding).not.toHaveProperty('name');
    expect(branding.logo?.mime).toBe('image/png');
    expect(Buffer.isBuffer(branding.logo?.data)).toBe(true);
  });
});

describe('branding sync when onboarding finishes', () => {
  const account = (details: boolean) => ({
    id: 'acct_branding_1', charges_enabled: details, payouts_enabled: details, details_submitted: details,
    requirements: { currently_due: [], disabled_reason: null },
  }) as never;

  it('pushes everything, the stored logo included, the first time the details are submitted', async () => {
    useOrg({ stripe_details_submitted: false });
    (prisma.organization as any).updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockRetrieve.mockResolvedValue(account(true));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })));
    const res = await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockBranding).toHaveBeenCalledTimes(1));
    expect(mockBranding.mock.calls[0]![0]).toBe('acct_branding_1');
    expect(mockBranding.mock.calls[0]![1].logo?.mime).toBe('image/png');
    expect(mockBranding.mock.calls[0]![1]).toMatchObject({ primaryColor: '#0C2D3A' });
    expect(mockBranding.mock.calls[0]![1]).not.toHaveProperty('name');
  });

  it('does not push again when the details were already submitted', async () => {
    useOrg({ stripe_details_submitted: true });
    (prisma.organization as any).updateMany = vi.fn().mockResolvedValue({ count: 1 });
    mockRetrieve.mockResolvedValue(account(true));
    await request(app).post('/api/organization/stripe/refresh-status').set(authHeader('admin'));
    await new Promise((r) => setTimeout(r, 20));
    expect(mockBranding).not.toHaveBeenCalled();
  });
});
