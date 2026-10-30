/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 5, slice S05.6 - the text inbox list, its thread header and the customer panel beside
// the thread draw the other party's number (and a matched customer's email) through the contact display policy,
// and the customer's name in the thread header links to the customer's page only with View customers.
//
// Renders the ROUTED Text page (pages/v2/communication/TextPage) with the real inbox in it. The person's switches
// come from the "Me" answer, keyed by the backend catalog's own keys; every case is a custom switch set.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import { useAuthStore } from '@/stores/auth.store';
import TextPage from '@/pages/v2/communication/TextPage';

const mockApi = vi.mocked(api);
const COMM = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

window.HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000077';
const STRANGER = '+16095550000';
const STRANGER_DIGITS = '(609) 555-0000';
const CONTACT_PHONE = '+12125551042';
const CONTACT_PHONE_DIGITS = '(212) 555-1042';
const CONTACT_EMAIL = 'facilities@rolex.example';

const CUSTOMERS = [
  {
    id: CUSTOMER_ID,
    name: 'Rolex 5th Ave',
    type: 'commercial',
    site: '665 Fifth Ave, NY',
    phones: [CONTACT_PHONE],
    contacts: [
      {
        id: 'ct_1',
        name: 'Daniel Cohen',
        preferredLang: 'en',
        channels: [
          { id: 'ch_s', kind: 'sms', value: CONTACT_PHONE, consented: true },
          { id: 'ch_e', kind: 'email', value: CONTACT_EMAIL },
        ],
      },
    ],
  },
];

const message = (id: string, direction: 'in' | 'out', body: string) => ({
  id, direction, body, ts: '2026-06-09T14:00:00Z', status: 'delivered',
});

const CUSTOMER_THREAD = {
  id: 'thr_customer', customerId: CUSTOMER_ID, channel: 'sms', campaignType: 'customer_care', unread: 0,
  messages: [message('m1', 'in', 'Are you coming Thursday?')],
};
const STRANGER_THREAD = {
  id: 'thr_stranger', customerId: '', channel: 'sms', campaignType: 'customer_care', unread: 0, title: STRANGER,
  messages: [message('m2', 'in', 'Do you fix garage doors?')],
};

interface Switches { copyPhone: boolean; copyEmail: boolean; viewCustomers: boolean }

function meAnswer(s: Switches) {
  return {
    admin_box: false,
    values: {
      [catalogToggle('Copy customer phone').key]: s.copyPhone,
      [catalogToggle('Copy customer email').key]: s.copyEmail,
      [catalogToggle('Contact customers').key]: true,
      [catalogToggle('View customers').key]: s.viewCustomers,
    },
  };
}

function renderInbox(switches: Switches) {
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
    if (url === '/api/permission-switches/me') return { data: meAnswer(switches) };
    if (url === '/api/communication/threads') return { data: { threads: [CUSTOMER_THREAD, STRANGER_THREAD] } };
    if (url === '/api/communication/contacts') return { data: { contacts: CUSTOMERS } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/numbers') return { data: { numbers: [] } };
    if (url === `/api/customers/${CUSTOMER_ID}`) return { data: { customer: { jobs: [] } } };
    return { data: {} };
  });
  return renderWithProviders(
    <Routes><Route path="/communication/text/:tab" element={<TextPage />} /></Routes>,
    { initialEntries: ['/communication/text/inbox'], ability: COMM },
  );
}

const ALL_ON: Switches = { copyPhone: true, copyEmail: true, viewCustomers: true };
const isSelectable = (el: HTMLElement) => !el.className.includes('select-none');

/** The inbox's pane for the open conversation: its header, then the customer panel beside it. */
const threadPane = () => document.querySelector<HTMLElement>('[data-pane="thread"]')!;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Text inbox, copy rules for the other party\'s number (S05.6)', () => {
  it('lists and heads an unknown-number conversation by a number that stays selectable with Copy customer phone on', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox(ALL_ON);
    const row = await screen.findByRole('button', { name: new RegExp(STRANGER_DIGITS.replace(/[()]/g, '\\$&')) });
    await user.click(row);

    // The switches arrive after the first paint, and the number is held back until they do.
    await vi.waitFor(() => expect(isSelectable(within(row).getByText(STRANGER_DIGITS))).toBe(true));
    expect(isSelectable(within(threadPane()).getByText(STRANGER_DIGITS))).toBe(true);
  });

  it('draws that number in the list and in the thread header as digits that cannot be selected or copied with Copy customer phone off', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox({ ...ALL_ON, copyPhone: false });
    const row = await screen.findByRole('button', { name: new RegExp(STRANGER_DIGITS.replace(/[()]/g, '\\$&')) });
    await user.click(row);

    // The switches arrive after the first paint; the number is judged once they have.
    await vi.waitFor(() => expect(isSelectable(within(row).getByText(STRANGER_DIGITS))).toBe(false));
    const header = within(threadPane()).getByText(STRANGER_DIGITS);
    expect(isSelectable(header)).toBe(false);
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    header.dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });

  it('draws the matched customer\'s phone and email in the panel beside the thread under their own two switches', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox({ ...ALL_ON, copyPhone: false });
    await user.click(await screen.findByRole('button', { name: /Rolex 5th Ave/ }));

    // Phone off, email on: only the phone is held back.
    await vi.waitFor(() => expect(isSelectable(screen.getByText(CONTACT_PHONE_DIGITS))).toBe(false));
    expect(isSelectable(screen.getByText(CONTACT_EMAIL))).toBe(true);
  });

  it('holds back the matched customer\'s email with Copy customer email off, and leaves the phone alone', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox({ ...ALL_ON, copyEmail: false });
    await user.click(await screen.findByRole('button', { name: /Rolex 5th Ave/ }));

    await vi.waitFor(() => expect(isSelectable(screen.getByText(CONTACT_EMAIL))).toBe(false));
    expect(isSelectable(screen.getByText(CONTACT_PHONE_DIGITS))).toBe(true);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
});

describe('Text inbox New message picker, copy rules for a customer\'s number (S05.6)', () => {
  it.each([
    ['selectable with Copy customer phone on', true],
    ['not selectable with Copy customer phone off', false],
  ])('lists a customer\'s number, %s', async (_label, copyPhone) => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox({ ...ALL_ON, copyPhone });
    await user.click(await screen.findByRole('button', { name: /^New/ }));

    const dialog = await screen.findByRole('dialog');
    const number = await within(dialog).findByText(CONTACT_PHONE_DIGITS);
    await vi.waitFor(() => expect(isSelectable(within(dialog).getByText(CONTACT_PHONE_DIGITS))).toBe(copyPhone));
    expect(number).toBeInTheDocument();
  });
});

describe('Text inbox thread header, the customer\'s name (S05.6)', () => {
  it('links the name to the customer page with View customers on', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox(ALL_ON);
    await user.click(await screen.findByRole('button', { name: /Rolex 5th Ave/ }));

    const link = await within(threadPane()).findByRole('link', { name: 'Rolex 5th Ave' });
    expect(link).toHaveAttribute('href', `/customers/${CUSTOMER_ID}`);
  });

  it('draws no link to the customer page with View customers off, and does not ask for the customer directory', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderInbox({ ...ALL_ON, viewCustomers: false });
    // The directory is not read for this person, so the conversation is found by what it says.
    await user.click(await screen.findByRole('button', { name: /Are you coming Thursday/ }));

    await vi.waitFor(() => expect(within(threadPane()).getAllByText('Are you coming Thursday?').length).toBeGreaterThan(0));
    expect(within(threadPane()).queryByRole('link')).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/communication/contacts');
  });
});
