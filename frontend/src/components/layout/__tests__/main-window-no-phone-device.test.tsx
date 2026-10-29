/// <reference types="@testing-library/jest-dom/vitest" />
// The phone device runs ONLY in the /phone tab (Ran, 2026-10-02).
//
// Both main-app layouts used to mount a warm-up that, on the user's first
// pointerdown/keydown anywhere in the window, loaded the vendor's phone script
// and booted a hidden device right here in the main window. Nothing in the main
// window ever used it: every Call button hands off to the /phone tab, and the
// inline dialer never gets a device handle. Worse, the vendor allows one device
// per browser (an exclusive navigator lock), so the main window won the lock,
// the /phone tab read "Phone active in another tab", and its calls rode on a
// window the user could close or reload at any moment.
//
// This guards both layouts: flag on, communication entitlement on, an office
// (ADMIN) user - exactly the conditions that used to boot the device - then a
// real gesture on the document. No device may be created and no vendor element
// may appear in the DOM. The device factory is the REAL one with only its
// script loader stubbed to resolve, so if anything does boot a device, the
// vendor element really lands in the document and the DOM assertion catches it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';

const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));

vi.mock('@/lib/communication/ctmSoftphone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/communication/ctmSoftphone')>();
  createSpy.mockImplementation((opts: Parameters<typeof actual.createCtmSoftphone>[0]) =>
    actual.createCtmSoftphone({ ...opts, scriptLoader: () => Promise.resolve() }),
  );
  return { ...actual, isCtmSoftphoneEnabled: vi.fn(() => true), createCtmSoftphone: createSpy };
});
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(() => true),
}));
vi.mock('@/lib/api/phoneNumbers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/phoneNumbers')>()),
  requestPhoneAccessToken: vi.fn(() => new Promise(() => {})),
}));
// Chrome the v2 shell carries that is irrelevant here and noisy in jsdom.
vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

import { teardownOfficeSoftphone } from '@/lib/communication/officeSoftphone';
import AppLayout from '../AppLayout';
import V2AppLayout from '@/pages/v2/V2AppLayout';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderLegacyLayout() {
  return renderWithProviders(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div>legacy dashboard</div>} />
      </Route>
    </Routes>,
    { initialEntries: ['/'], ability: adminAbility },
  );
}

function renderV2Layout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={adminAbility}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>v2 dashboard</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Every way the user's first interaction with the window can arrive. */
async function gestureEverywhere() {
  await act(async () => {
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    fireEvent.touchStart(document.body);
    // Let a booted device's script-load promise settle and append its element.
    await Promise.resolve();
    await Promise.resolve();
  });
}

function expectNoDeviceInThisWindow() {
  expect(createSpy).not.toHaveBeenCalled();
  expect(document.querySelector('ctm-phone-embed')).toBeNull();
  expect(document.querySelector('ctm-device-embed')).toBeNull();
}

beforeEach(() => {
  createSpy.mockClear();
  localStorage.clear();
});

afterEach(() => {
  // A regression would leave a live singleton behind for the next test.
  teardownOfficeSoftphone();
});

describe('main app window never boots the phone device', () => {
  it('legacy AppLayout: no device and no vendor element after the first gesture', async () => {
    renderLegacyLayout();
    expect(screen.getByText('legacy dashboard')).toBeInTheDocument();

    await gestureEverywhere();

    expectNoDeviceInThisWindow();
  });

  it('v2 V2AppLayout: no device and no vendor element after the first gesture', async () => {
    renderV2Layout();
    expect(screen.getByText('v2 dashboard')).toBeInTheDocument();

    await gestureEverywhere();

    expectNoDeviceInThisWindow();
  });
});
