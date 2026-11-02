// Mobile slice 50: the contact action, now only for numbers that are not a customer's (a vendor's). Tapping a number
// offers Call or Text; an org without the phone service gets a plain device link; and (slice
// 63) Call on every site goes to the ServWave dialer on every device: the hand-off, not the
// component, decides between the phone tab and the same-tab sheet.
//
// RED before the component exists. Nothing here places a call or sends a text: the dial handoff,
// the device link and the router are all stand-ins.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

const state = vi.hoisted(() => ({ phoneService: true, onPhone: false }));

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => state.phoneService,
}));
vi.mock('@/lib/device/isPhoneDevice', () => ({ isPhoneDevice: () => state.onPhone }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('../contactHrefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contactHrefs')>()),
  openDeviceLink: vi.fn(),
}));

import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { openDeviceLink } from '../contactHrefs';
import { PhoneNumberAction } from '../ContactAction';

const mockRequestCall = vi.mocked(requestCall);
const mockOpenDeviceLink = vi.mocked(openDeviceLink);

const PHONE = '5551234567';
const CONTEXT = { customerId: 'cust-1', customerName: 'Dana Reyes' };
// Contact customers needs View communication.
const dialer = buildAbility([{ action: 'read', subject: 'Communication' }, { action: 'create', subject: 'Communication' }]);
const noDialer = buildAbility([{ action: 'read', subject: 'Communication' }]);

function mockWidth(belowMd: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MEDIA.belowMd && belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.phoneService = true;
  state.onPhone = false;
  mockWidth(false);
});

describe('tapping a number', () => {
  it('offers Call and Text, and never dials by itself', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: dialer });

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));

    expect(await screen.findByRole('menuitem', { name: /Call/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Text/ })).toBeInTheDocument();
    // There is no Copy.
    expect(screen.queryByRole('menuitem', { name: /Copy/i })).toBeNull();
    expect(mockRequestCall).not.toHaveBeenCalled();
    expect(mockOpenDeviceLink).not.toHaveBeenCalled();
  });

  it('on a computer, Call opens the dialer pre-filled with the number and the record it came from', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: dialer });

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));

    expect(mockRequestCall).toHaveBeenCalledWith(PHONE, CONTEXT);
    expect(mockOpenDeviceLink).not.toHaveBeenCalled();
  });

  it('Text opens the ServWave conversation with that customer', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <PhoneNumberAction phone={PHONE} context={CONTEXT} />
        <Where />
      </>,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: /Text/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/communication/text?customerId=cust-1');
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('Text on a number nobody on file owns opens the conversation by number', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <PhoneNumberAction phone="+15559876543" />
        <Where />
      </>,
      { ability: dialer },
    );

    await user.click(screen.getByRole('button', { name: '(555) 987-6543' }));
    await user.click(await screen.findByRole('menuitem', { name: /Text/ }));

    expect(screen.getByTestId('where')).toHaveTextContent('/communication/text?to=%2B15559876543');
  });

  it('below md the choice is a bottom sheet with 44 px rows', async () => {
    mockWidth(true);
    const user = userEvent.setup();
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: dialer });

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    const sheet = await screen.findByRole('dialog');
    const call = within(sheet).getByRole('button', { name: /Call/ });
    const text = within(sheet).getByRole('button', { name: /Text/ });
    expect(call).toHaveClass('min-h-11');
    expect(text).toHaveClass('min-h-11');
  });
});

// Mobile slice 63: every Call opens the ServWave dialer on every device. The contact action no
// longer reads the device: on a phone the hand-off opens the same-tab sheet instead of the phone tab
// (lib/communication/__tests__/phone-tab-handoff-same-tab.test.ts), so a site that used to call
// natively on a phone no longer does.
describe('on a phone', () => {
  it('Call from a number opens the dialer, not the phone app', async () => {
    state.onPhone = true;
    const user = userEvent.setup();
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: dialer });

    await user.click(screen.getByRole('button', { name: '(555) 123-4567' }));
    await user.click(await screen.findByRole('menuitem', { name: /Call/ }));

    expect(mockRequestCall).toHaveBeenCalledWith(PHONE, CONTEXT);
    expect(mockOpenDeviceLink).not.toHaveBeenCalled();
  });
});

describe('an org without the ServWave phone service', () => {
  it('gets a plain device call link, with no choice and no dialer', async () => {
    state.phoneService = false;
    const user = userEvent.setup();
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: dialer });

    const link = screen.getByRole('link', { name: '(555) 123-4567' });
    expect(link).toHaveAttribute('href', 'tel:5551234567');
    link.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot navigate to tel:
    await user.click(link);
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('a user who may not place calls gets the same plain link', () => {
    renderWithProviders(<PhoneNumberAction phone={PHONE} context={CONTEXT} />, { ability: noDialer });

    expect(screen.getByRole('link', { name: '(555) 123-4567' })).toHaveAttribute('href', 'tel:5551234567');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
