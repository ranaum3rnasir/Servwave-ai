import { beforeEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';

import PaymentsPage from '../PaymentsPage';
import { PHONE_TAP_AREA } from '../phoneTap';
import { makeItem, serveAttention } from './attentionFixtures';
import { makeDetail, makeRow, manyRows, mockApi } from './paymentsFixtures';
import { makePayout, servePayouts } from './payoutsFixtures';

/**
 * Phone tap targets, final polish: the page and every overlay it opens carry the ONE phone rule, so a control inside
 * is 44px tall at phone width without the kit's defaults changing. Real heights are measured in a browser at 390px;
 * this keeps the rule from being dropped from a surface later.
 */
const OWNER = buildAbility(catalogToggle('Manage payout account').grants.map((g) => ({ action: g.action, subject: g.subject }) as never));
const ROW1 = manyRows(3)[0]!;
const user = () => userEvent.setup();

const carries = (el: Element | null) => expect(el?.className, 'the phone rule is on this surface').toContain(PHONE_TAP_AREA);

function withStatus() {
  const base = mockApi.get.getMockImplementation()!;
  mockApi.get.mockImplementation(((url: string, config?: unknown) => {
    if (url === '/api/organization/stripe/status') {
      return Promise.resolve({ data: { connected: true, terms_accepted: true, stripe_charges_enabled: true, stripe_payouts_enabled: true } });
    }
    return (base as (...a: unknown[]) => unknown)(url, config);
  }) as never);
}

beforeEach(() => mockApi.get.mockReset());

describe('the rule itself', () => {
  it('covers buttons, selects, options, inputs and links on a phone, and leaves checkboxes alone', () => {
    for (const part of ['[&_button:', '[&_[role=combobox]]', '[&_[role=option]]', '[&_input:', '[&_a]:inline-flex']) {
      expect(PHONE_TAP_AREA).toContain(part);
    }
    expect(PHONE_TAP_AREA).toContain(':not([role=checkbox])');
    for (const token of PHONE_TAP_AREA.split(' ')) expect(token.startsWith('max-sm:'), token).toBe(true);
  });
});

describe('the surfaces', () => {
  it('the page itself', async () => {
    serveAttention({ open: [], rows: [ROW1] });
    withStatus();
    const { container } = renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    await screen.findByRole('tablist');
    carries(container.querySelector('[class*="gap-5"]'));
  });

  it('the payment drawer and its refund dialog', async () => {
    serveAttention({ open: [], rows: manyRows(3), detail: () => makeDetail(ROW1) });
    withStatus();
    renderWithProviders(<PaymentsPage />, { initialEntries: [`/payments?payment=${ROW1.id}`], ability: OWNER });
    const drawer = await screen.findByRole('dialog', { name: 'Payment PMT-000001' });
    carries(drawer);
    await user().click(await within(drawer).findByRole('button', { name: 'Refund' }));
    carries(await screen.findByRole('dialog', { name: 'Refund payment' }));
  });

  it('the payout drawer and the Update bank account dialog', async () => {
    const failed = makePayout(1, { status: 'FAILED' });
    servePayouts({ payouts: [failed] });
    withStatus();
    renderWithProviders(<PaymentsPage />, { initialEntries: [`/payments?tab=payouts&payout=${failed.id}`], ability: OWNER });
    const drawer = await screen.findByRole('dialog', { name: 'Payout PO-000001' });
    carries(drawer);
    await user().click(await within(drawer).findByRole('button', { name: 'Update bank account' }));
    carries(await screen.findByRole('dialog', { name: 'Update bank account' }));
  });

  it('a Needs attention dialog', async () => {
    serveAttention({ open: [makeItem(2, 'failed_payment', { actions: ['mark_resolved'] })], rows: [makeRow(2)] });
    withStatus();
    renderWithProviders(<PaymentsPage />, { initialEntries: ['/payments'], ability: OWNER });
    await user().click(await screen.findByRole('button', { name: 'Mark resolved' }));
    carries(await screen.findByRole('dialog', { name: 'Mark as resolved' }));
  });
});
