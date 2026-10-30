/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 5, slice S05.6 - the incoming-call card is part of the dialer's caller match, so it draws
// the caller's number and the matched customer's name through the same contact display policy as the screen-pop.
//
// The browser phone does not answer inbound calls today (BROWSER_INBOUND_ANSWER_ENABLED is off), so the card is
// not reachable from the routed /phone tab and is rendered on its own here; the rule it follows is the one the
// routed dialer test (pages/v2/communication/__tests__/copy-rules-dialer-caller-match.test.tsx) covers.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

const CALLER = '+16098745252';
const CALLER_DIGITS = '(609) 874-5252';

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    fmtPhone: actual.fmtPhone,
    matchByNumber: actual.matchByNumber,
    usePhoneCustomers: () => ({
      data: [
        {
          id: 'cust-1', name: 'Sample Customer', type: 'commercial', site: '',
          contacts: [{ id: 'c1', name: 'Jamie Rivera', preferredLang: 'en', channels: [{ id: 'ch', kind: 'phone', value: '+16098745252' }] }],
        },
      ],
    }),
  };
});

import { IncomingCallCard } from '../IncomingCallCard';

const mockApi = vi.mocked(api);

function renderCard(copyPhone: boolean, viewCustomers: boolean) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') {
      return {
        data: {
          admin_box: false,
          values: {
            [catalogToggle('Copy customer phone').key]: copyPhone,
            [catalogToggle('View customers').key]: viewCustomers,
          },
        },
      };
    }
    return { data: {} };
  });
  return renderWithProviders(<IncomingCallCard info={{ from: CALLER }} onAnswer={vi.fn()} onDecline={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('Incoming call card, copy rules (S05.6)', () => {
  it('keeps the caller\'s number selectable and links the matched name with Copy customer phone and View customers on', async () => {
    renderCard(true, true);
    const link = await screen.findByRole('link', { name: 'Sample Customer' });
    expect(link).toHaveAttribute('href', '/customers/cust-1');
    // The switches arrive after the first paint, and the number is held back until they do.
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).not.toContain('select-none'));
  });

  it('holds the number back and shows the name as plain text with both switches off', async () => {
    renderCard(false, false);
    await vi.waitFor(() => expect(screen.getByText(CALLER_DIGITS).className).toContain('select-none'));
    expect(screen.getByText('Sample Customer')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sample Customer' })).not.toBeInTheDocument();
  });
});
