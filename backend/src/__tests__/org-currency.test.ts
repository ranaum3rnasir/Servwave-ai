import { describe, it, expect, vi, beforeEach } from 'vitest';

// #126 — backend org-aware currency. getOrgCurrency resolves the org's
// configured currency (mirrors getOrgTimezone), defaulting to USD and never
// throwing in fire-and-forget email/PDF paths.

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('../lib/prisma', () => ({
  prisma: { organization: { findUnique } },
}));

let getOrgCurrency: typeof import('../lib/timezone')['getOrgCurrency'];

beforeEach(async () => {
  findUnique.mockReset();
  const mod = await vi.importActual<typeof import('../lib/timezone')>('../lib/timezone');
  getOrgCurrency = mod.getOrgCurrency;
});

describe('getOrgCurrency', () => {
  it('returns the org currency when set', async () => {
    findUnique.mockResolvedValue({ currency: 'EUR' });
    expect(await getOrgCurrency('org-1')).toBe('EUR');
  });

  it('defaults to USD when the org has no currency', async () => {
    findUnique.mockResolvedValue({ currency: null });
    expect(await getOrgCurrency('org-1')).toBe('USD');
  });

  it('defaults to USD when the org is missing', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getOrgCurrency('org-1')).toBe('USD');
  });

  it('defaults to USD (never throws) when the lookup fails', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    expect(await getOrgCurrency('org-1')).toBe('USD');
  });
});
