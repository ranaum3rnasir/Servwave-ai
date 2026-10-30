/// <reference types="@testing-library/jest-dom/vitest" />
// S08.24: a missed call or an inbound text that nobody was linked to reaches the people who manage roles and permissions, and a holder
// who cannot read the conversation is told in an alert with no caller details: no name, no number, no preview. The bell must show such a
// row sensibly (what happened, on which company number, when, why) and open the right page, without printing "undefined" or an empty
// line where the caller would be.
//
// The REAL panel runs against the real HTTP client; only the transport is replaced, and it answers what the server stores for these
// alerts.
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

const REASON = 'Nobody is linked to this number and nobody sees every call and text.';
const CALL_ID = 'c0000000-0000-0000-0000-0000000000c1';
const THREAD_ID = 't0000000-0000-0000-0000-0000000000t1';

const base: NotificationView = {
  id: 'n0', verb: '', category: 'COMMUNICATION', priority: 'FEED', needs_action: false, title: '', body: null,
  object_type: '', object_id: '', object_label: null, action_type: null, data: {},
  created_at: new Date().toISOString(), seen_at: null, read_at: null, acted_at: null,
};

/** What the server stores for each: the alert without caller details (a call, a voicemail, a text) and the full one for a holder who can read. */
const redactedCall: NotificationView = {
  ...base, id: 'r1', verb: 'communication.call_missed', priority: 'INTERRUPT', needs_action: true, action_type: 'VIEW', object_type: 'CALL', object_id: CALL_ID,
  title: 'Missed call on (555) 555-0142', body: `October 12, 2026 at 7:05 PM\n${REASON}`,
  data: { call_status: 'missed', fallback_reason: REASON, company_number: '(555) 555-0142', occurred_at: 'October 12, 2026 at 7:05 PM', redacted: true },
};
const redactedText: NotificationView = {
  ...base, id: 'r2', verb: 'communication.sms_inbound', object_type: 'MESSAGE_THREAD', object_id: THREAD_ID,
  title: 'New text on (555) 555-0142', body: `October 12, 2026 at 7:05 PM\n${REASON}`,
  data: { fallback_reason: REASON, company_number: '(555) 555-0142', occurred_at: 'October 12, 2026 at 7:05 PM', redacted: true },
};
const redactedNoNumber: NotificationView = {
  ...base, id: 'r3', verb: 'communication.sms_inbound', object_type: 'MESSAGE_THREAD', object_id: THREAD_ID,
  title: 'New text on a company number', body: `October 12, 2026 at 7:05 PM\n${REASON}`,
  data: { fallback_reason: REASON, occurred_at: 'October 12, 2026 at 7:05 PM', redacted: true },
};
const fullText: NotificationView = {
  ...base, id: 'f1', verb: 'communication.sms_inbound', object_type: 'MESSAGE_THREAD', object_id: THREAD_ID, object_label: 'Pat Payer',
  title: 'New text — Pat Payer', body: `Gate code is 9931\nOn (555) 555-0142, October 12, 2026 at 7:05 PM\n${REASON}`,
  data: { customer_name: 'Pat Payer', preview: 'Gate code is 9931', fallback_reason: REASON, company_number: '(555) 555-0142', occurred_at: 'October 12, 2026 at 7:05 PM' },
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

describe('the bell panel with alerts from the never-silent fallback', () => {
  it('shows an alert without caller details as what happened, on which company number, when and why, with no caller line', async () => {
    serverAnswers([redactedCall, redactedText]);
    const { container } = renderWithProviders(<NotificationPanel />);

    expect(await screen.findByText('Missed call on (555) 555-0142')).toBeInTheDocument();
    expect(screen.getByText('New text on (555) 555-0142')).toBeInTheDocument();
    // The body is the time and the reason, on two lines, in that order.
    const bodies = screen.getAllByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes(REASON));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.textContent).toBe(`October 12, 2026 at 7:05 PM\n${REASON}`);
    // Nothing of a caller, and no hole where one would be.
    expect(container.textContent).not.toMatch(/undefined|null|NaN/);
    expect(container.textContent).not.toMatch(/Pat Payer|9931/);
    // Every row is a title and a body: no empty paragraph is left behind.
    expect(Array.from(container.querySelectorAll('p')).filter((p) => (p.textContent ?? '').trim() === '')).toEqual([]);
  });

  it('says "a company number" when the number could not be placed, without printing a blank', async () => {
    serverAnswers([redactedNoNumber]);
    const { container } = renderWithProviders(<NotificationPanel />);

    expect(await screen.findByText('New text on a company number')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/undefined|null/);
  });

  it('shows the full alert of a holder who can read the conversation with the caller and the preview, as for any text', async () => {
    serverAnswers([fullText]);
    renderWithProviders(<NotificationPanel />);

    expect(await screen.findByText('New text — Pat Payer')).toBeInTheDocument();
    const body = screen.getByText((_, el) => el?.tagName === 'P' && (el.textContent ?? '').includes('Gate code is 9931'));
    expect(body.textContent).toBe(`Gate code is 9931\nOn (555) 555-0142, October 12, 2026 at 7:05 PM\n${REASON}`);
  });

  it('opens the call log from a call alert and the Text page, on that conversation, from a text alert', async () => {
    serverAnswers([redactedCall, redactedText]);
    renderWithProviders(<><NotificationPanel /><Where /></>);

    await userEvent.click(await screen.findByText('Missed call on (555) 555-0142'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/communication/phone'));

    await userEvent.click(screen.getByText('New text on (555) 555-0142'));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/communication/text?threadId=${THREAD_ID}`));
  });
});
