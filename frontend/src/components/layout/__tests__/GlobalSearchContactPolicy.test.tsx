/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 5, slice S05.5: where a top-search row shows a customer's email (the customer rows' second
// line), it follows the contact display policy. With Copy customer email off the address is still readable but cannot
// be selected or copied; with it on, the row is as it was. Rows carry the customer's phone on the wire but draw none
// (and offer no call or mail link), so a phone never reaches the page from this screen.
//
// The person's switches come from the "Me" answer, keyed by the catalog's own keys (read from the backend catalog file).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { seedMySwitches } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import GlobalSearch from '../GlobalSearch';

const get = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { get: (...a: unknown[]) => get(...a) } }));

const none = { jobs: [], customers: [], leads: [], estimates: [], invoices: [], servicePlans: [], calendarEntries: [] };
const EMAIL = 'dana@example.test';
const PHONE_DIGITS = '5551234567';

function meValues(copyEmail: boolean) {
  return {
    [catalogToggle('Copy customer email').key]: copyEmail,
    [catalogToggle('Copy customer phone').key]: false,
    [catalogToggle('View customers').key]: true,
  };
}

async function searchWithCopyEmail(copyEmail: boolean) {
  seedMySwitches(meValues(copyEmail));
  get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values: meValues(copyEmail) } };
    return {
      data: {
        results: {
          ...none,
          customers: [{ id: 'c1', entity_type: 'customer', title: 'Dana Reyes', subtitle: EMAIL, phone: PHONE_DIGITS }],
          jobs: [{ id: 'j1', entity_type: 'job', title: 'J-1001', subtitle: 'Dana Reyes', phone: PHONE_DIGITS, status: 'SCHEDULED' }],
        },
      },
    };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <GlobalSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await user.type(screen.getByRole('combobox', { name: 'Search everything' }), 'rey');
  return within(await screen.findByRole('listbox'));
}

beforeEach(() => {
  get.mockReset();
  localStorage.clear();
});

describe('a customer row in top search', () => {
  it('Copy customer email off: the address shows but cannot be selected or copied', async () => {
    const list = await searchWithCopyEmail(false);

    const address = await list.findByText(EMAIL);
    expect(address).toHaveClass('select-none');
    // A copy event the page lets through reports true; one it blocks reports false.
    expect(fireEvent.copy(address)).toBe(false);
  });

  it('Copy customer email on: the address is ordinary selectable text, as before', async () => {
    const list = await searchWithCopyEmail(true);

    const address = await list.findByText(EMAIL);
    expect(address).not.toHaveClass('select-none');
    expect(fireEvent.copy(address)).toBe(true);
  });

  it('draws no phone number and no call, text or mail link, whatever the switches say', async () => {
    const list = await searchWithCopyEmail(true);
    await list.findByText(EMAIL);

    expect(document.body.textContent ?? '').not.toContain(PHONE_DIGITS);
    expect(document.body.textContent ?? '').not.toContain('(555) 123-4567');
    expect(document.querySelector('a[href^="tel:"], a[href^="sms:"], a[href^="mailto:"]')).toBeNull();
  });
});
