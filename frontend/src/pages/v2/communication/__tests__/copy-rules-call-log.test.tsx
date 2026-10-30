/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 5, slice S05.6 - the call log rows and the call detail draw the other party's number
// through the contact display policy: with Copy customer phone off the digits stay on screen and stay readable to a
// screen reader, but cannot be selected or copied, and there is no copy control and no native link.
//
// Renders the ROUTED Phone page (pages/v2/communication/PhonePage) with the real call log in it. The person's
// switches come from the "Me" answer, keyed by the backend catalog's own keys; every case is a custom switch set.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { DESKTOP, PHONE_PORTRAIT, emulateDevice } from '@/__tests__/support/deviceShape';

vi.mock('@/components/communication/phone/DispatchView', () => ({ DispatchView: () => null }));
vi.mock('@/components/communication/phone/PerformanceView', () => ({ PerformanceView: () => null }));
vi.mock('@/components/communication/phone/TrainingView', () => ({ TrainingView: () => null }));
vi.mock('@/components/communication/phone/NumbersView', () => ({ NumbersView: () => null }));
vi.mock('@/components/communication/phone/BlockedCallersView', () => ({ BlockedCallersView: () => null }));
vi.mock('@/components/communication/phone/CallFlows', () => ({ CallFlowsView: () => null }));
vi.mock('@/components/communication/phone/CallGroups', () => ({ CallGroupsView: () => null }));
vi.mock('@/components/communication/phone/CallMaskingView', () => ({ CallMaskingView: () => null }));
vi.mock('@/pages/v2/communication/components/planUsage', () => ({ PlanUsage: () => null }));
vi.mock('@/components/communication/shared/useAttachTargets', () => ({
  useAttachTargets: () => ({ search: '', setSearch: vi.fn(), querying: false, jobs: [], leads: [], isLoading: false }),
}));

import { useAuthStore } from '@/stores/auth.store';
import PhonePage from '@/pages/v2/communication/PhonePage';

const mockApi = vi.mocked(api);
const COMM_READ = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const CUSTOMER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CALLER = '+15551230000';
const CALLER_DIGITS = '(555) 123-0000';
const COMPANY_LINE = '+12019037784';
const COMPANY_LINE_DIGITS = '(201) 903-7784';

const CALL = {
  id: 'cd000000-0000-0000-0000-000000000001',
  direction: 'inbound',
  fromNumber: CALLER,
  toNumber: COMPANY_LINE,
  status: 'missed',
  answeredBy: { kind: 'none' },
  startedAt: new Date().toISOString(),
  durationSec: 0,
  customerId: CUSTOMER_ID,
};

/** The "Me" answer for a person holding exactly these switches. */
function meAnswer(copyPhone: boolean) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: copyPhone,
      [catalogToggle('Copy customer email').key]: copyPhone,
      [catalogToggle('Contact customers').key]: true,
      [catalogToggle('View customers').key]: true,
    },
  };
}

async function renderCallLog(copyPhone: boolean, calls: Array<{ customerId?: string }> = [CALL]) {
  vi.mocked(useAuthStore).mockImplementation((sel: unknown) =>
    (sel as (s: unknown) => unknown)({
      user: {
        id: 'u1', email: 'custom@test.com', first_name: 'Custom', last_name: 'Role', role: 'CUSTOM',
        organization_id: '00000000-0000-4000-8000-000000000a01', org_is_demo: false, org_features: ['phone'],
      },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: meAnswer(copyPhone) };
    if (url === '/api/communication/calls') return { data: { calls } };
    if (url === '/api/communication/contacts') {
      return { data: { contacts: [{ id: CUSTOMER_ID, name: 'Daniel Cohen', type: 'residential', site: '', contacts: [] }] } };
    }
    return { data: { threads: [], callFlows: [], callGroups: [], blocked: [], numbers: [], agents: [], techs: [] } };
  });
  renderWithProviders(
    <Routes><Route path="/communication/phone/:tab" element={<PhonePage />} /></Routes>,
    { initialEntries: ['/communication/phone/calls'], ability: COMM_READ },
  );
  // The customer's name arrives with the contacts; the row is judged after that.
  if (calls.some((c) => c.customerId)) await screen.findByText('Daniel Cohen');
}

let restoreDevice: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  restoreDevice = emulateDevice({ ...DESKTOP, viewportWidth: 1280 });
});
afterEach(() => restoreDevice());

describe('Phone page call log, copy rules for the other party\'s number (S05.6)', () => {
  it('a row shows the customer number selectable with Copy customer phone on, as today', async () => {
    await renderCallLog(true);
    await screen.findByText(CALLER_DIGITS);
    // The switches arrive after the first paint, and the number is held back until they do.
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).not.toContain('select-none'));
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
  });

  it('a row shows the digits but not selectable, with no copy control and no native link, with Copy customer phone off', async () => {
    await renderCallLog(false);
    // The switches arrive after the first paint; the number is judged once they have.
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).toContain('select-none'));

    const number = screen.getByText(CALLER_DIGITS);
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    number.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });

  it('leaves the company\'s own line alone: it is not a customer number', async () => {
    await renderCallLog(false);
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).toContain('select-none'));
    expect(screen.getByText(COMPANY_LINE_DIGITS).className).not.toContain('select-none');
  });

  it('the call detail draws the number under the name the same way, in both directions of the switch', async () => {
    const user = userEvent.setup();
    await renderCallLog(false);
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).toContain('select-none'));

    await user.click(screen.getByText('Daniel Cohen'));
    const drawer = await screen.findByRole('dialog');
    const heading = within(drawer).getByText(CALLER_DIGITS);
    expect(heading.className).toContain('select-none');

    // The From line under "Call details" is the customer's number too; the To line is the company's.
    await user.click(within(drawer).getByRole('button', { name: /call details/i }));
    const fromLine = within(drawer).getAllByText(CALLER_DIGITS).find((el) => el !== heading)!;
    expect(fromLine.className).toContain('select-none');
    expect(within(drawer).getByText(COMPANY_LINE_DIGITS).className).not.toContain('select-none');
    expect(within(drawer).queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    fireEvent.keyDown(drawer, { key: 'Escape' });
  });

  it('the call detail keeps the number selectable with Copy customer phone on', async () => {
    const user = userEvent.setup();
    await renderCallLog(true);
    await user.click(screen.getByText('Daniel Cohen'));
    const drawer = await screen.findByRole('dialog');
    await vi.waitFor(() => expect(within(drawer).getByText(CALLER_DIGITS).className).not.toContain('select-none'));
  });
});

describe('Phone page call log on a phone, copy rules for the other party\'s number (S05.6)', () => {
  // A caller with no customer record is named by their number on the card.
  const UNKNOWN_CALL = { ...CALL, id: 'cd000000-0000-0000-0000-000000000002', customerId: undefined };

  it.each([
    ['not selectable with Copy customer phone off', false, true],
    ['selectable with Copy customer phone on', true, false],
  ])('a card names the caller by number, %s', async (_label, copyPhone, notSelectable) => {
    restoreDevice();
    restoreDevice = emulateDevice({ ...PHONE_PORTRAIT, viewportWidth: 390 });
    await renderCallLog(copyPhone, [UNKNOWN_CALL]);

    // The card names the unknown caller by number (the title) and shows it again under From.
    await vi.waitFor(() => expect(screen.getAllByText(CALLER_DIGITS).length).toBeGreaterThanOrEqual(2));
    // The switches arrive after the first paint; settle on the answer for this person.
    await vi.waitFor(() => {
      const classes = screen.getAllByText(CALLER_DIGITS).map((el) => el.className.includes('select-none'));
      expect(classes.every((c) => c === notSelectable)).toBe(true);
    });
    expect(screen.getByText(COMPANY_LINE_DIGITS).className).not.toContain('select-none');
  });
});
