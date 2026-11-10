/// <reference types="@testing-library/jest-dom/vitest" />
// The /phone tab on a PHONE (Ran, 2026-10-02): the browser phone never loads
// there, and Call goes out as the bridge - the phone service rings the user's
// own cell first, then the customer. A browser-phone call from an iPhone
// connected with no audio either way, so a phone must never get one.
//
// Real page, real dialer hook, real device singleton, and the REAL device
// factory with only its script loader stubbed: if anything boots a device, the
// vendor element really lands in the document. The bridge request goes through
// the real usePlaceCall; only the HTTP client underneath is replaced. The phone
// itself is emulated through the browser inputs the phone check reads (primary
// pointer and screen size), not by mocking the check.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

const { createSpy, post, myNumbers, abilityRules } = vi.hoisted(() => ({
  createSpy: vi.fn(),
  post: vi.fn(),
  // The caller's ability rules, set per case: the person holds the "Office phone in the browser" switch by default.
  abilityRules: { current: [] as Array<{ action: string; subject: string }> },
  // The caller's allow-listed numbers (the "Calling from" picker). None by default.
  myNumbers: { current: undefined as unknown },
}));

vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  createSpy.mockImplementation((opts: Parameters<typeof actual.createCtmSoftphone>[0]) =>
    actual.createCtmSoftphone({ ...opts, scriptLoader: () => Promise.resolve() }),
  );
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true), createCtmSoftphone: createSpy };
});

// An office admin, signed in, of an org with the phone feature on: exactly the
// user who gets the browser phone on a computer.
vi.mock('@/stores/auth.store', async () => {
  const { create } = await import('zustand');
  const useAuthStore = create(() => ({
    user: {
      id: 'u1',
      organization_id: 'org-1',
      email: 'office@test.com',
      first_name: 'O',
      last_name: 'U',
      role: 'ADMIN',
    },
    isAuthenticated: true,
    isLoading: false,
    error: null,
  }));
  return { useAuthStore, userDisplayName: () => '' };
});
// Roles & Permissions S08.18: the browser phone is the "Office phone in the browser" switch, read from the person's
// ability. Most cases are about the device and the surface, so the person holds the switch; the case that does not
// sets `abilityRules.current` to an empty list.
vi.mock('@/contexts/AbilityContext', async (importOriginal) => {
  const { buildAbility } = await import('@/lib/ability');
  let built: { rules: unknown; ability: ReturnType<typeof buildAbility> } | null = null;
  const useAppAbility = () => {
    // One ability object per rule set, so a re-render does not hand the page a new one.
    if (!built || built.rules !== abilityRules.current) {
      built = { rules: abilityRules.current, ability: buildAbility(abilityRules.current as never) };
    }
    return built.ability;
  };
  return { ...(await importOriginal<typeof import('@/contexts/AbilityContext')>()), useAppAbility };
});
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));

vi.mock('@/lib/axios', () => ({
  default: { post, get: vi.fn(() => Promise.resolve({ data: {} })) },
}));
// Everything the console reads, except the bridge request itself (the real
// usePlaceCall, over the stubbed HTTP client above).
vi.mock('@/lib/api/communication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/communication')>()),
  usePhoneCustomers: () => ({ data: [] }),
  useCallOutcome: () => ({ data: null }),
  useStashCallAttribution: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
    isPending: false,
  }),
  useCalls: () => ({ data: [] }),
  useDialerSearch: () => ({ data: undefined, isFetching: false }),
}));
vi.mock('@/lib/api/phoneNumbers', () => ({
  requestPhoneAccessToken: vi.fn(() => new Promise(() => {})),
  useMyNumbers: () => ({ data: myNumbers.current }),
}));
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: () => ({ data: undefined }),
}));

import PhoneTabPage from '@/pages/v2/communication/PhoneTabPage';
import { teardownOfficeSoftphone } from '@/lib/communication/officeSoftphone';
import { DESKTOP, PHONE_PORTRAIT, emulateDevice } from '@/__tests__/support/deviceShape';

let restoreDevice: (() => void) | null = null;

function renderPhoneTab(url = '/phone') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <PhoneTabPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Lets a booted device's script-load promise settle and append its element. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  createSpy.mockClear();
  post.mockReset();
  post.mockResolvedValue({ data: {} });
  localStorage.clear();
  myNumbers.current = undefined;
  abilityRules.current = [{ action: 'use_browser_phone', subject: 'Communication' }];
});

afterEach(() => {
  teardownOfficeSoftphone();
  restoreDevice?.();
  restoreDevice = null;
});

describe('/phone tab on a phone', () => {
  it('loads no browser phone: the device is never created and no vendor element is added', async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    renderPhoneTab();
    await settle();

    expect(createSpy).not.toHaveBeenCalled();
    expect(document.querySelector('ctm-phone-embed')).toBeNull();
    expect(document.querySelector('ctm-device-embed')).toBeNull();
  });

  it('never shows device states: it reads Ready, not "Connecting…", "Phone active in another tab" or a start prompt', async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    renderPhoneTab();
    await settle();

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
    expect(screen.queryByText('Phone active in another tab')).not.toBeInTheDocument();
    expect(screen.queryByText('Click anywhere to start the phone')).not.toBeInTheDocument();
  });

  it("Call places the bridge call: it asks the phone service to ring the user's own phone first", async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    renderPhoneTab();
    await settle();

    fireEvent.change(screen.getByPlaceholderText('Enter a number'), {
      target: { value: '+15555550123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/communication/calls',
        expect.objectContaining({ direction: 'out', to_number: '+15555550123' }),
      ),
    );
    // No pick made: no explicit caller number, so the server picks the default.
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('from_number_id');
    expect(await screen.findByText('Your phone will ring first.')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('the "Calling from" pick rides the bridge call as the ServWave number id, never the phone service id', async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    myNumbers.current = {
      numbers: [
        {
          phone_number_id: '11111111-1111-4111-8111-111111111111',
          provider_number_id: 'TPN-AAA',
          formatted: '(609) 555-0100',
          is_org_default: true,
          is_user_default: false,
        },
        {
          phone_number_id: '22222222-2222-4222-8222-222222222222',
          provider_number_id: 'TPN-BBB',
          formatted: '(555) 010-0142',
          is_org_default: false,
          is_user_default: false,
        },
      ],
    };
    renderPhoneTab();
    await settle();

    await userEvent.click(screen.getByRole('combobox', { name: 'Calling from' }));
    await userEvent.click(screen.getByRole('option', { name: /\(555\) 010-0142/ }));
    fireEvent.change(screen.getByPlaceholderText('Enter a number'), {
      target: { value: '+15555550123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/communication/calls',
        expect.objectContaining({
          to_number: '+15555550123',
          from_number_id: '22222222-2222-4222-8222-222222222222',
        }),
      ),
    );
    expect(JSON.stringify(post.mock.calls[0]?.[1])).not.toContain('TPN-');
    // #3025: the call screen names the picked number as the one to answer.
    await waitFor(() =>
      expect(screen.queryAllByRole('status').map((el) => el.textContent)).toContain(
        'Your phone will ring first. Answer the call from (555) 010-0142 to connect.',
      ),
    );
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('a ?dial= handoff from a Call button is placed as the bridge too', async () => {
    restoreDevice = emulateDevice(PHONE_PORTRAIT);
    renderPhoneTab('/phone?dial=%2B15550001111');
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/communication/calls',
        expect.objectContaining({ to_number: '+15550001111' }),
      ),
    );
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// The control: the same user on a computer still gets the browser phone, so the
// assertions above are measuring the phone check, not a page that never boots.
describe('/phone tab on a computer (unchanged)', () => {
  it('boots the browser phone and reads "Connecting…" while it starts', async () => {
    restoreDevice = emulateDevice(DESKTOP);
    renderPhoneTab();
    await settle();

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('ctm-phone-embed')).not.toBeNull();
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
  });
});

// Roles & Permissions S08.18: the switch, not the device, decides. Without "Office phone in the browser" a computer
// places the same bridge call a phone does (it rings the person's own phone first), and no browser phone is ever created.
describe('/phone tab on a computer without the "Office phone in the browser" switch', () => {
  it('Call places the bridge call and never creates the browser phone', async () => {
    abilityRules.current = [];
    restoreDevice = emulateDevice(DESKTOP);
    renderPhoneTab();
    await settle();

    expect(createSpy).not.toHaveBeenCalled();
    expect(document.querySelector('ctm-phone-embed')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('Enter a number'), {
      target: { value: '+15555550123' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Call' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        '/api/communication/calls',
        expect.objectContaining({ direction: 'out', to_number: '+15555550123' }),
      ),
    );
    expect(await screen.findByText('Your phone will ring first.')).toBeInTheDocument();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
