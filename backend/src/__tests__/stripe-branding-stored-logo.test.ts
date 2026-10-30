// Payments go-live slice 33b - the stored-logo read is safe by construction: it fetches only a URL under the
// app's own storage public prefix, never follows a redirect, and stops at a few MB. The network is the one
// thing stubbed (global fetch); the sync itself runs for real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { updateAccountBranding } from '../lib/stripe';
import { syncOrgBranding } from '../lib/stripe-branding';

const mockBranding = vi.mocked(updateAccountBranding);
const orgFindUnique = prisma.organization.findUnique as unknown as ReturnType<typeof vi.fn>;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OWN_LOGO = 'https://test.supabase.co/storage/v1/object/public/org-assets/logo.png';

const fetchStub = vi.fn();
const useLogoUrl = (logo_url: string | null) => orgFindUnique.mockResolvedValue({
  name: 'Harbor Locksmiths LLC', brand_color: '#0C2D3A', logo_url, stripe_account_id: 'acct_branding_1',
});
const logoSent = () => mockBranding.mock.calls[0]![1].logo;

beforeEach(() => {
  vi.clearAllMocks();
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  mockBranding.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('syncOrgBranding reading the stored logo', () => {
  it('reads a logo under the app\'s own storage and sends it, asking not to follow redirects', async () => {
    useLogoUrl(OWN_LOGO);
    fetchStub.mockResolvedValue(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));

    await syncOrgBranding('org-1', { logo: 'stored' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(logoSent()).toMatchObject({ mime: 'image/png' });
  });

  it.each([
    ['another host', 'https://evil.example/storage/v1/object/public/org-assets/logo.png'],
    ['an internal address', 'http://169.254.169.254/latest/meta-data/'],
    ['the app\'s host but outside its public storage path', 'https://test.supabase.co/rest/v1/organizations?select=*'],
    ['a look-alike host', 'https://test.supabase.co.evil.example/storage/v1/object/public/org-assets/logo.png'],
    ['a path that climbs out of the prefix', 'https://test.supabase.co/storage/v1/object/public/../../../rest/v1/x'],
  ])('refuses a URL on %s: nothing is fetched, the colour still goes', async (_label, url) => {
    useLogoUrl(url);

    await syncOrgBranding('org-1', { logo: 'stored' });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(mockBranding).toHaveBeenCalledTimes(1);
    expect(logoSent()).toBeUndefined();
    expect(mockBranding.mock.calls[0]![1]).toEqual({ primaryColor: '#0C2D3A' });
  });

  it('refuses a redirect: the logo is not sent', async () => {
    useLogoUrl(OWN_LOGO);
    fetchStub.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));

    await syncOrgBranding('org-1', { logo: 'stored' });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(logoSent()).toBeUndefined();
    expect(mockBranding).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that announces more than the cap', async () => {
    useLogoUrl(OWN_LOGO);
    fetchStub.mockResolvedValue(new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) } }));

    await syncOrgBranding('org-1', { logo: 'stored' });

    expect(logoSent()).toBeUndefined();
    expect(mockBranding).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that grows past the cap although it announced nothing', async () => {
    useLogoUrl(OWN_LOGO);
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 20) controller.enqueue(chunk);
        else controller.close();
      },
    });
    fetchStub.mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'image/png' } }));

    await syncOrgBranding('org-1', { logo: 'stored' });

    expect(logoSent()).toBeUndefined();
    expect(sent).toBeLessThan(10); // stopped reading, did not pull the whole 20 MB
    expect(mockBranding).toHaveBeenCalledTimes(1);
  });
});
