/**
 * #2981 round 2 - the wait / out-of-date messages land in the card of the control that failed, on
 * every payment door of the routed estimate page: the signed-not-paid (Pending) list, the "Deposit
 * due" card, and Decline.
 */
import { useEffect } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import PublicEstimatePage from '../PublicEstimatePage';

function SignatureCanvasStub(props: { onEnd?: () => void }) {
  useEffect(() => {
    props.onEnd?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
vi.mock('react-signature-canvas', () => ({ default: SignatureCanvasStub }));

const page = (status: 'SENT' | 'PENDING' | 'WON', policy = 'REQUIRED_BEFORE_APPROVAL') => ({
  estimate: {
    id: 'est-slot', estimate_number: 'E02981', status,
    tax_rate: 0, subtotal: 1000, tax_amount: 0, total_amount: 1000, scope_notes: '', line_items: [],
    send_config: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: ['CARD', 'ACH', 'CHECK'], message_body: null },
    invoices: [{ id: 'dep-inv-slot', kind: 'DEPOSIT', status: 'SENT', total_amount: 500, amount_due: 500, public_token: 'dep-tok' }],
    lead: { customer: { first_name: 'Pat', last_name: 'Customer', company_name: null } }, customer: null,
    signature_data: status === 'SENT' ? null : 'data:image/png;base64,abc',
    signature_at: status === 'SENT' ? null : '2026-10-30T14:42:00.000Z',
    approved_at: status === 'WON' ? '2026-10-30T14:42:00.000Z' : null,
    terms_accepted: null,
  },
  organization: { name: 'Org', estimate_terms: null, phone: '5551234567' },
  payment_instructions: {},
  payment_options: { deposit_policy: policy },
  deposit: { pay_state: 'PAYABLE', hold_reason: null, payable_now: 500, processing_amount: 0 },
  expired: false,
});

function open(doc: unknown, post: { status: number; body: unknown }) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_u: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? Promise.resolve({ ok: false, status: post.status, json: async () => post.body })
      : Promise.resolve({ ok: true, status: 200, json: async () => doc })));
  return renderWithProviders(
    <Routes><Route path="/p/estimates/:id" element={<PublicEstimatePage />} /></Routes>,
    { initialEntries: ['/p/estimates/est-slot?token=tok'] },
  );
}

const WAIT = /We are experiencing issues\. Please try again in a few minutes or call us at \(555\) 123-4567\./;
const STALE = /This link is out of date\. Please open the latest link we sent you, or call us at \(555\) 123-4567\./;
const alertText = async () => (await screen.findByTestId('public-action-error')).textContent ?? '';

afterEach(() => vi.unstubAllGlobals());

describe.each([
  [429, { error: 'Too many requests', retryAfter: 600 }, WAIT],
  [404, { error: 'Not found' }, STALE],
] as const)('a %s on the estimate page', (status, body, message) => {
  it('on a Pending-panel card row shows the message in that panel', async () => {
    open(page('PENDING'), { status, body });
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay with credit\/debit card/i }));
    expect(await alertText()).toMatch(message);
  });

  it('on a Pending-panel bank row shows the message in that panel', async () => {
    open(page('PENDING'), { status, body });
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay by bank account/i }));
    expect(await alertText()).toMatch(message);
  });

  it('on the "Deposit due" card row shows the message', async () => {
    open(page('WON', 'PAY_LATER'), { status, body });
    await userEvent.setup().click(await screen.findByRole('button', { name: /pay deposit by card/i }));
    expect(await alertText()).toMatch(message);
  });

  it('on Decline shows the message', async () => {
    // SENT with no deposit: the Approve / Decline pair.
    const doc = page('SENT');
    doc.estimate.send_config = { ...doc.estimate.send_config, deposit_required: false };
    doc.estimate.invoices = [];
    open(doc, { status, body });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^decline$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /decline estimate/i }));
    expect(await alertText()).toMatch(message);
  });
});
