// Settings -> Phone & SMS, guarding the naming boundary in CLAUDE.md: no vendor
// or customer name is visible to a user, and no provider account identifier is
// ever rendered.
//
// The page shipped naming the telephony vendor in five places and printing the
// vendor account id on screen. It also asked an unconfigured org to type that
// account id into a labelled field, which cannot be de-branded - the value IS
// the vendor's identifier - so provisioning moved to ops and the form is gone.
//
// The assertions read the whole rendered DOM rather than named elements on
// purpose: a future edit that reintroduces the vendor anywhere on this page
// should fail here, not only an edit to the strings this test knows about.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import PhoneSmsPage from '@/pages/v2/settings/PhoneSmsPage';
import { Toaster as KitToaster, toast } from '@/ui-kit/components/ui/sonner';

const mockApi = vi.mocked(api);

const adminAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);

const BANNED = [/\bCTM\b/i, /CallTrackingMetrics/i, /A2P/i, /sub-account/i];

/** The body GET /api/organization sends: `phone_connected`, plus the deprecated
 *  `ctm_account_id` as a bare true/null (never the id - the server test pins
 *  that) for old bundles only. The page must follow `phone_connected`. */
function mockOrg(
  over: { phone_connected?: boolean; ctm_account_id?: true | null; ctm_sms_ready?: boolean } = {},
) {
  const phoneConnected = over.phone_connected ?? true;
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') {
      return {
        data: {
          id: '00000000-0000-0000-0000-000000000001',
          name: 'Test Org',
          phone_connected: phoneConnected,
          ctm_account_id: 'ctm_account_id' in over ? over.ctm_account_id : phoneConnected || null,
          ctm_sms_ready: over.ctm_sms_ready ?? true,
        },
      };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg();
});

const render = () => renderWithProviders(<PhoneSmsPage />, { ability: adminAbility });

describe('PhoneSmsPage - the provider is never named or identified', () => {
  it('names no vendor when the service is active', async () => {
    render();
    expect(await screen.findByText('Phone System')).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    for (const banned of BANNED) expect(text).not.toMatch(banned);
  });

  it('shows the service as active without exposing how it is wired', async () => {
    render();
    // Two Active badges: the phone service and, because sms_ready is true here,
    // text messaging. Both are status, neither is an identifier.
    expect(await screen.findAllByText('Active')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('reports a pending carrier registration without naming the campaign type', async () => {
    mockOrg({ ctm_sms_ready: false });
    render();

    expect(await screen.findByText('Pending registration')).toBeInTheDocument();
    expect(screen.getByText('Awaiting carrier approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh status/i })).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/A2P/i);
  });

  it('points an unconfigured org at support instead of asking for an account id', async () => {
    mockOrg({ phone_connected: false });
    render();

    expect(await screen.findByText(/contact support to\s+enable it/i)).toBeInTheDocument();
    // The account-id field is the whole reason this branch changed: an input
    // here would be a labelled vendor identifier no matter what it is called.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^connect$/i })).not.toBeInTheDocument();
  });

  // A new bundle can meet the old backend for a couple of minutes during a
  // ship: no phone_connected, the account id in ctm_account_id. Status only,
  // and the id is never printed.
  it('reads an old backend (no phone_connected) from the old key, printing no id', async () => {
    mockApi.get.mockImplementation(async (url: string) =>
      url === '/api/organization'
        ? { data: { id: '00000000-0000-0000-0000-000000000001', name: 'Test Org', ctm_account_id: '123456', ctm_sms_ready: true } }
        : { data: {} },
    );
    render();

    expect(await screen.findAllByText('Active')).toHaveLength(2);
    expect(document.body.textContent ?? '').not.toContain('123456');
  });

  it('follows phone_connected over the deprecated key when both are present', async () => {
    mockOrg({ phone_connected: false, ctm_account_id: true });
    render();

    expect(await screen.findByText(/contact support to\s+enable it/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /turn off/i })).not.toBeInTheDocument();
  });

  // The texting flag arrives as `sms_ready` (the new backend also sends the
  // deprecated `ctm_sms_ready`); the page must follow the neutral key alone.
  it.each([
    [true, 'Active'],
    [false, 'Pending registration'],
  ] as const)('reads texting status from sms_ready alone (sms_ready: %s)', async (ready, label) => {
    mockApi.get.mockImplementation(async (url: string) =>
      url === '/api/organization'
        ? { data: { id: '00000000-0000-0000-0000-000000000001', name: 'Test Org', phone_connected: true, sms_ready: ready } }
        : { data: {} },
    );
    render();

    expect(await screen.findByText('Phone System')).toBeInTheDocument();
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    if (!ready) expect(screen.getByText('Awaiting carrier approval')).toBeInTheDocument();
    else expect(screen.queryByText('Pending registration')).not.toBeInTheDocument();
  });

  it('does not tell the customer that anything is configured outside ServWave', async () => {
    render();
    expect(await screen.findByText('Phone System')).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/dashboard/i);
    expect(text).not.toMatch(/manual setup/i);
    expect(text).not.toMatch(/recording-consent/i);
  });
});

// The page's two actions call paths that carry ServWave's name, never the
// vendor's. The frontend and backend deploy minutes apart in no fixed order,
// so a 404 from an old backend that lacks the new path falls back to the old
// one; any other failure is reported as it is, never retried elsewhere.
describe('PhoneSmsPage - the phone actions use neutral paths', () => {
  // The kit's real Toaster is mounted so the outcome copy is read off the page.
  const render = () =>
    renderWithProviders(
      <>
        <PhoneSmsPage />
        <KitToaster />
      </>,
      { ability: adminAbility },
    );
  afterEach(() => {
    toast.dismiss();
  });

  const notFound = () => Object.assign(new Error('Request failed with status code 404'), {
    isAxiosError: true,
    response: { status: 404, data: { error: 'Not found' } },
  });

  it('refreshes the texting status through /phone/check-texting-approval', async () => {
    mockOrg({ ctm_sms_ready: false });
    mockApi.post.mockResolvedValue({ data: { sms_ready: false } });
    render();

    await userEvent.click(await screen.findByRole('button', { name: /refresh status/i }));

    await vi.waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    expect(mockApi.post).toHaveBeenCalledWith('/api/organization/phone/check-texting-approval');
  });

  it('falls back to the old texting-status path when an old backend 404s the new one', async () => {
    mockOrg({ ctm_sms_ready: false });
    mockApi.post.mockImplementation(async (url: string) => {
      if (url === '/api/organization/phone/check-texting-approval') throw notFound();
      return { data: { sms_ready: true } };
    });
    render();

    await userEvent.click(await screen.findByRole('button', { name: /refresh status/i }));

    await vi.waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/organization/connect-ctm/check-a2p'),
    );
    expect(await screen.findByText('Text messaging is active')).toBeInTheDocument();
  });

  it('does not retry the old path on a failure that is not a 404', async () => {
    mockOrg({ ctm_sms_ready: false });
    mockApi.post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 409'), {
        isAxiosError: true,
        response: { status: 409, data: { error: 'Organization is not connected to a phone system' } },
      }),
    );
    render();

    await userEvent.click(await screen.findByRole('button', { name: /refresh status/i }));

    expect(await screen.findByText("Couldn't refresh the text messaging status")).toBeInTheDocument();
    expect(mockApi.post).toHaveBeenCalledTimes(1);
  });

  it('turns the service off through /phone/disconnect, falling back to the old path on a 404', async () => {
    mockApi.post.mockImplementation(async (url: string) => {
      if (url === '/api/organization/phone/disconnect') throw notFound();
      return { data: { connected: false } };
    });
    render();

    await userEvent.click(await screen.findByRole('button', { name: /turn off/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^turn off$/i }));

    await vi.waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/organization/disconnect-ctm'),
    );
    expect(mockApi.post).toHaveBeenNthCalledWith(1, '/api/organization/phone/disconnect');
    expect(await screen.findByText('Phone service turned off')).toBeInTheDocument();
  });
});
