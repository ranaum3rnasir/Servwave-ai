/// <reference types="@testing-library/jest-dom/vitest" />
// S10.10: a customer's reply to an email rings the record's people, and when none of them can take it the people who cover for them
// are told why. The bell must show the reason line under the subject, never print "undefined" or an empty line where one is missing,
// and open the Email page from the row.
//
// The REAL panel runs against the real HTTP client; only the transport is replaced, and it answers what the server stores for these alerts.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AxiosAdapter, InternalAxiosRequestConfig } from 'axios';
import { useLocation } from 'react-router-dom';

vi.unmock('@/lib/axios');

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { NotificationPanel } from '../NotificationPanel';
import type { NotificationView } from '@/lib/api/notifications';

const REASON = 'This job has no Dispatcher or Sold By who can take this reply';
const THREAD_ID = 'e0000000-0000-0000-0000-0000000000e1';

const base: NotificationView = {
  id: 'n0', verb: 'communication.email_inbound', category: 'COMMUNICATION', priority: 'FEED', needs_action: false, title: '', body: null,
  object_type: 'EMAIL_THREAD', object_id: THREAD_ID, object_label: 'Pat Payer <pat@example.com>', action_type: null, data: {},
  created_at: new Date().toISOString(), seen_at: null, read_at: null, acted_at: null,
};

/** What the server stores for a reply told to the record's people, to a person covering for a record with nobody to take it, and to a reply with no subject. */
const plain: NotificationView = {
  ...base, id: 'p1', title: 'New email — Pat Payer <pat@example.com>', body: 'Re: Your visit', data: { subject: 'Re: Your visit', fallback_reason: '' },
};
const covering: NotificationView = {
  ...base, id: 'c1', title: 'New email — Pat Payer <pat@example.com>', body: `Re: Your visit\n${REASON}`,
  data: { subject: 'Re: Your visit', fallback_reason: REASON },
};
const noSubject: NotificationView = {
  ...base, id: 's1', title: 'New email — Pat Payer <pat@example.com>', body: REASON, data: { fallback_reason: REASON },
};

/** What the server stores for a reply from an address we didn't send to (S10.19): PRD 10's words, and the held message the row opens. */
const UNMATCHED_TITLE = "A reply from an address we didn't send to - check and link it";
const unmatched: NotificationView = {
  ...base, id: 'u1', title: UNMATCHED_TITLE, body: 'Re: Your invoice',
  data: { subject: 'Re: Your invoice', fallback_reason: '', unmatched_reply: true, link_path: '/communication/inbox?review=held-1' },
};

function serverAnswers(items: NotificationView[]) {
  const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => ({
    data: config.method === 'get' ? { items, nextCursor: null } : {},
    status: 200, statusText: 'OK', headers: {}, config,
  });
  api.defaults.adapter = adapter;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname + location.search}</div>;
}

beforeEach(() => vi.clearAllMocks());

describe('the bell panel with a customer\'s email reply', () => {
  it('shows the reason line under the subject for a person covering, and the subject alone for the record\'s own people', async () => {
    serverAnswers([plain, covering]);
    const { container } = renderWithProviders(<NotificationPanel />);

    expect(await screen.findAllByText('New email — Pat Payer <pat@example.com>')).toHaveLength(2);
    const bodies = screen.getAllByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes('Re: Your visit'));
    expect(bodies.map((b) => b.textContent).sort()).toEqual(['Re: Your visit', `Re: Your visit\n${REASON}`]);
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('shows the reason line alone when the reply has no subject, with no empty paragraph', async () => {
    serverAnswers([noSubject]);
    const { container } = renderWithProviders(<NotificationPanel />);

    const body = await screen.findByText(REASON);
    expect(body.textContent).toBe(REASON);
    expect(Array.from(container.querySelectorAll('p')).filter((p) => (p.textContent ?? '').trim() === '')).toEqual([]);
  });

  it('opens the Email page from the row', async () => {
    serverAnswers([covering]);
    renderWithProviders(<><NotificationPanel /><Where /></>);

    await userEvent.click(await screen.findByText('New email — Pat Payer <pat@example.com>'));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox'));
  });
});

describe('the bell panel with a reply from an address we didn\'t send to', () => {
  it('shows PRD 10\'s words and the subject, and opens the Needs review item on the Email page from the row', async () => {
    serverAnswers([unmatched]);
    renderWithProviders(<><NotificationPanel /><Where /></>);

    expect(await screen.findByText('Re: Your invoice')).toBeInTheDocument();
    await userEvent.click(await screen.findByText(UNMATCHED_TITLE));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox?review=held-1'));
  });
});
