/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 5, slice S05.6 - the dialer's caller match draws the other party's number through the
// contact display policy (Copy customer phone), and the matched customer's name links to their page only with View
// customers. The dialer is the /phone tab (PhoneTabPage), the one softphone surface; a call placed from it with no
// browser phone on the line takes the bridge path, which shows the screen-pop for the number being dialled.
//
// The person's switches come from the "Me" answer, keyed by the backend catalog's own keys; every case is a custom
// switch set.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

const placeCall = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const stashAttribution = vi.hoisted(() => ({
  mutate: vi.fn(),
  mutateAsync: vi.fn().mockResolvedValue({ queued: true }),
  isPending: false,
}));

const CUSTOMER_ID = 'cust-1';
const CALLEE = '+16098745252';
const CALLEE_DIGITS = '(609) 874-5252';

const PHONE_CUSTOMERS = [
  {
    id: CUSTOMER_ID,
    name: 'Sample Customer',
    type: 'commercial',
    site: '12 Main St',
    contacts: [
      {
        id: 'contact-1',
        name: 'Jamie Rivera',
        role: 'Ops manager',
        preferredLang: 'en',
        channels: [{ id: 'ch-1', kind: 'phone', value: CALLEE }],
      },
    ],
  },
];

const search = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    BUSINESS_NUMBER: '(551) 282-7064',
    fmtPhone: actual.fmtPhone,
    matchByNumber: actual.matchByNumber,
    usePhoneCustomers: () => ({ data: PHONE_CUSTOMERS }),
    usePlaceCall: () => placeCall,
    useStashCallAttribution: () => stashAttribution,
    useCallOutcome: () => ({ data: null }),
    useCalls: () => ({ data: [] }),
    useDialerSearch: (q: string) => ({ data: q.trim().length >= 2 ? search.current : undefined, isFetching: false }),
  };
});

// No browser phone on the line: a call takes the bridge path and the console shows the dialled number at once.
vi.mock('@/lib/communication/useCtmSoftphone', () => ({ useCtmSoftphone: () => null }));
vi.mock('@/lib/api/myOutboundNumber', () => ({
  useMyOutboundNumber: vi.fn((enabled = true) => ({ data: enabled ? { none: true } : undefined })),
}));
vi.mock('@/lib/api/phoneNumbers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/phoneNumbers')>('@/lib/api/phoneNumbers');
  return { ...actual, useMyNumbers: vi.fn(() => ({ data: { numbers: [] } })) };
});

import PhoneTabPage from '@/pages/v2/communication/PhoneTabPage';

const mockApi = vi.mocked(api);

interface Switches { copyPhone: boolean; viewCustomers: boolean }
const ALL_ON: Switches = { copyPhone: true, viewCustomers: true };

function renderDialer(s: Switches) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') {
      return {
        data: {
          admin_box: false,
          values: {
            [catalogToggle('Copy customer phone').key]: s.copyPhone,
            [catalogToggle('Copy customer email').key]: s.copyPhone,
            [catalogToggle('Contact customers').key]: true,
            [catalogToggle('View customers').key]: s.viewCustomers,
          },
        },
      };
    }
    return { data: {} };
  });
  return renderWithProviders(<PhoneTabPage />);
}

async function dial(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText('Enter a number'), '6098745252');
  await user.click(screen.getByRole('button', { name: 'Call' }));
}

const isSelectable = (el: HTMLElement) => !el.className.includes('select-none');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  search.current = undefined;
});

describe('Dialer caller match, the number (S05.6)', () => {
  it('shows the dialled number selectable with Copy customer phone on, as today', async () => {
    const user = userEvent.setup();
    renderDialer(ALL_ON);
    await dial(user);

    await screen.findByText(CALLEE_DIGITS);
    // The switches arrive after the first paint, and the number is held back until they do.
    await vi.waitFor(() => expect(isSelectable(screen.getByText(CALLEE_DIGITS))).toBe(true));
  });

  it('shows the dialled number as digits that cannot be selected or copied, with no copy control or native link, with Copy customer phone off', async () => {
    const user = userEvent.setup();
    renderDialer({ ...ALL_ON, copyPhone: false });
    await dial(user);

    // The switches arrive after the first paint; the number is judged once they have.
    await vi.waitFor(() => expect(isSelectable(screen.getByText(CALLEE_DIGITS))).toBe(false));
    const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
    screen.getByText(CALLEE_DIGITS).dispatchEvent(copyEvent);
    expect(copyEvent.defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"]')).toBeNull();
  });
});

describe('Dialer caller match, the customer\'s name (S05.6)', () => {
  it('links the matched customer\'s name to their page with View customers on', async () => {
    const user = userEvent.setup();
    renderDialer(ALL_ON);
    await dial(user);

    const link = await screen.findByRole('link', { name: 'Sample Customer' });
    expect(link).toHaveAttribute('href', `/customers/${CUSTOMER_ID}`);
  });

  it('shows the matched customer\'s name as plain text, with no link, with View customers off', async () => {
    const user = userEvent.setup();
    renderDialer({ ...ALL_ON, viewCustomers: false });
    await dial(user);

    await screen.findByText('Sample Customer');
    expect(screen.queryByRole('link', { name: 'Sample Customer' })).not.toBeInTheDocument();
  });
});

describe('Dialer search results and customer panel, the number (S05.6)', () => {
  const RESULT = {
    query: { isPhone: false, e164: null },
    customers: [{ id: CUSTOMER_ID, name: 'Sample Customer', phone: CALLEE, site: '12 Main St', openJobs: [] }],
    jobs: [],
    identity: null,
  };

  it.each([
    ['selectable with Copy customer phone on', true],
    ['not selectable with Copy customer phone off', false],
  ])('draws a result\'s number, then the picked customer\'s panel number, %s', async (_label, copyPhone) => {
    const user = userEvent.setup();
    search.current = RESULT;
    renderDialer({ ...ALL_ON, copyPhone });
    await user.type(screen.getByPlaceholderText(/Search a job #/), 'sample');

    const row = await screen.findByRole('button', { name: /Sample Customer/ });
    await vi.waitFor(() => expect(isSelectable(within(row).getByText(CALLEE_DIGITS))).toBe(copyPhone));

    await user.click(row);
    // The customer panel header shows the same number, under the same rule.
    const panelNumbers = await screen.findAllByText(CALLEE_DIGITS);
    for (const el of panelNumbers) expect(isSelectable(el)).toBe(copyPhone);
  });
});
