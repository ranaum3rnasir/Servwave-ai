/**
 * Payments go-live slice 20 - Settings > Payments: the org payment defaults.
 *
 * Each control is driven the way an owner drives it and saved through the page's real save path
 * (the saver it hands the settings Save bar), and the assertion is on what reaches
 * PATCH /api/organization. The online methods (Card, Bank) save their own booleans and never edit
 * CARD or ACH in accepted_payment_methods: those two are server-owned capability facts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';

let registeredSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      registeredSave = fns.save;
    },
  }),
}));
// The embedded onboarding SDKs do not render in jsdom.
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
  ConnectAccountManagement: () => <div />,
  ConnectNotificationBanner: () => <div />,
}));

// Imported after the mocks above so the page picks up the captured saver.
const { default: ServwavePaymentsPage } = await import('@/pages/v2/settings/ServwavePaymentsPage');

const mockApi = vi.mocked(api);

const PAGE_ABILITY = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);


/** An org whose payout account can take both cards and bank payments. */
const ACTIVE_ORG = {
  id: 'o1',
  stripe_connected: true,
  stripe_charges_enabled: true,
  accepted_payment_methods: ['CARD', 'ACH', 'CASH'],
  card_offered_by_default: true,
  bank_offered_by_default: true,
  tips_enabled: false,
  tip_presets: [10, 15, 20],
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
  bank_transfer_instructions: null,
  source_options: [],
  job_type_options: [],
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

function serveOrg(org: Record<string, unknown>) {
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/organization' ? Promise.resolve({ data: org }) : Promise.resolve({ data: {} }),
  );
}

/** Renders the page and waits until the form has been hydrated from the org. */
async function renderPage(org: Record<string, unknown> = ACTIVE_ORG) {
  serveOrg(org);
  const user = userEvent.setup();
  const view = renderWithProviders(<ServwavePaymentsPage />, { ability: PAGE_ABILITY });
  await screen.findByDisplayValue('40');
  return { user, ...view };
}

async function saveAndGetPatch() {
  await registeredSave?.();
  await waitFor(() => expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', expect.anything()));
  return mockApi.patch.mock.calls.at(-1)![1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredSave = null;
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('Settings > Payments: offered online methods', () => {
  it('switching Card off saves card_offered_by_default and leaves CARD in the accepted methods alone', async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole('switch', { name: 'Credit card' }));
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ card_offered_by_default: false });
  });

  it('switching Bank on saves bank_offered_by_default and leaves ACH in the accepted methods alone', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, bank_offered_by_default: false });

    const bank = screen.getByRole('switch', { name: 'Bank (ACH)' });
    expect(bank).not.toBeChecked();
    await user.click(bank);
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ bank_offered_by_default: true });
  });

  const REASON = 'Finish payout account verification first.';

  it('an account that cannot take payments yet shows Card and Bank as unavailable, disabled, with the reason', async () => {
    await renderPage({
      ...ACTIVE_ORG,
      stripe_charges_enabled: false,
      accepted_payment_methods: ['CASH'],
    });

    for (const name of ['Credit card', 'Bank (ACH)']) {
      const toggle = screen.getByRole('switch', { name });
      expect(toggle).toHaveAttribute('aria-disabled', 'true');
      expect(toggle).toHaveAccessibleDescription(expect.stringContaining(REASON));
    }
    expect(screen.getAllByText(REASON)).toHaveLength(2);
    expect(screen.getAllByText('Unavailable')).toHaveLength(2);
    // Unavailable, not off: the switches keep the owner's saved preference, which applies once
    // the account can take the method.
    expect(screen.getByRole('switch', { name: 'Credit card' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Bank (ACH)' })).toBeChecked();
  });

  it('a manual method still edits accepted_payment_methods, and the online toggles stay out of that list', async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole('checkbox', { name: 'Check' }));
    const patch = await saveAndGetPatch();

    expect(Object.keys(patch)).toEqual(['accepted_payment_methods']);
    expect(patch.accepted_payment_methods).toEqual(expect.arrayContaining(['CASH', 'CHECK']));
    expect(screen.queryByRole('checkbox', { name: /credit card$/i })).not.toBeInTheDocument();
  });

  it('an account that takes cards but not bank payments yet has Card available and Bank unavailable', async () => {
    await renderPage({ ...ACTIVE_ORG, accepted_payment_methods: ['CARD', 'CASH'] });

    const card = screen.getByRole('switch', { name: 'Credit card' });
    expect(card).not.toHaveAttribute('aria-disabled', 'true');
    expect(card).not.toHaveAccessibleDescription(expect.stringContaining(REASON));
    const bank = screen.getByRole('switch', { name: 'Bank (ACH)' });
    expect(bank).toHaveAttribute('aria-disabled', 'true');
    expect(bank).toHaveAccessibleDescription(expect.stringContaining(REASON));
    expect(screen.getAllByText(REASON)).toHaveLength(1);
  });

  it('a listed CARD with charges switched off is still unavailable (charges are the card capability)', async () => {
    await renderPage({ ...ACTIVE_ORG, stripe_charges_enabled: false });

    expect(screen.getByRole('switch', { name: 'Credit card' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('switch', { name: 'Bank (ACH)' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('Settings > Payments: tips', () => {
  it('switching tips on saves tips_enabled', async () => {
    const { user } = await renderPage();

    await user.click(screen.getByRole('switch', { name: 'Let customers add a tip' }));
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ tips_enabled: true });
  });

  it('editing a preset saves all three presets as whole percentages', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, tips_enabled: true });

    const second = screen.getByRole('textbox', { name: 'Choice 2' });
    expect(second).toHaveValue('15');
    await user.tripleClick(second);
    await user.keyboard('18');
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ tip_presets: [10, 18, 20] });
  });

  it('a preset outside 1-50% is refused inline and nothing is saved', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, tips_enabled: true });

    const third = screen.getByRole('textbox', { name: 'Choice 3' });
    await user.tripleClick(third);
    await user.keyboard('75');
    await expect(registeredSave?.()).rejects.toThrow();

    expect(await screen.findByText('Enter a whole number from 1 to 50.')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('a refused preset marks only its own field invalid (aria-invalid drives the error border)', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, tips_enabled: true });

    const third = screen.getByRole('textbox', { name: 'Choice 3' });
    await user.tripleClick(third);
    await user.keyboard('60');
    await expect(registeredSave?.()).rejects.toThrow();
    await screen.findByText('Enter a whole number from 1 to 50.');

    expect(third).toHaveAttribute('aria-invalid', 'true');
    // The aria-invalid:border-destructive utility generates no CSS in this build, so the
    // border must be an explicit class that does (border-danger), on the refused field only.
    expect(third.className).toMatch(/(^|\s)border-danger(\s|$)/);
    for (const name of ['Choice 1', 'Choice 2']) {
      const ok = screen.getByRole('textbox', { name });
      expect(ok).not.toHaveAttribute('aria-invalid', 'true');
      expect(ok.className).not.toMatch(/(^|\s)border-danger(\s|$)/);
    }
  });

  it('the three tip presets are laid out on one grid row (stacked on a phone)', async () => {
    await renderPage({ ...ACTIVE_ORG, tips_enabled: true });

    const row = screen.getByRole('textbox', { name: 'Choice 1' }).closest('[data-testid="tip-presets-row"]');
    expect(row).not.toBeNull();
    expect(row!.className).toMatch(/sm:grid-cols-3/);
    expect(row!.className).toMatch(/grid-cols-1/);
    expect(row!.querySelectorAll('input')).toHaveLength(3);
  });

  it('a bad preset left behind when tips are switched off is not sent (its boxes are hidden)', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, tips_enabled: true });

    const first = screen.getByRole('textbox', { name: 'Choice 1' });
    await user.tripleClick(first);
    await user.keyboard('0');
    await user.click(screen.getByRole('switch', { name: 'Let customers add a tip' }));
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ tips_enabled: false });
  });
});

describe('Settings > Payments: deposit policy', () => {
  it('shows the saved policy and saves "Allow approval now, deposit paid later" as PAY_LATER', async () => {
    const { user } = await renderPage();

    expect(screen.getByRole('radio', { name: 'Require the deposit before approval' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Allow approval now, deposit paid later' }));
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ deposit_policy: 'PAY_LATER' });
  });

  it('saves "Require the deposit before approval" as REQUIRED_BEFORE_APPROVAL', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, deposit_policy: 'PAY_LATER' });

    expect(screen.getByRole('radio', { name: 'Allow approval now, deposit paid later' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Require the deposit before approval' }));
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ deposit_policy: 'REQUIRED_BEFORE_APPROVAL' });
  });
});

describe('Settings > Payments: bank-transfer instructions', () => {
  it('shows the saved instructions and saves the edited text', async () => {
    const { user } = await renderPage({ ...ACTIVE_ORG, bank_transfer_instructions: 'Routing 000' });

    const field = screen.getByRole('textbox', { name: 'Instructions customers see' });
    expect(field).toHaveValue('Routing 000');
    await user.clear(field);
    await user.type(field, 'Wire to account 123, reference your invoice number');
    const patch = await saveAndGetPatch();

    expect(patch).toEqual({ bank_transfer_instructions: 'Wire to account 123, reference your invoice number' });
  });

  it('says that recording a transfer stays manual, in a ? popover and not a grey line under the field', async () => {
    const { user } = await renderPage();

    const field = screen.getByRole('textbox', { name: 'Instructions customers see' });
    expect(field).not.toHaveAccessibleDescription();
    expect(screen.queryByText(/when one arrives, record the payment/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More about Bank-transfer instructions' }));
    expect(await screen.findByText(/when one arrives, record the payment on the invoice yourself/)).toBeInTheDocument();
  });
});

describe('Settings > Payments: copy', () => {
  /** Every word a user or the DOM can show: text, plus every attribute value (labels, titles, placeholders, ids). */
  function everythingVisible(root: HTMLElement): string {
    const parts = [root.textContent ?? ''];
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.attributes) if (attr.name !== 'class') parts.push(attr.value);
    }
    return parts.join(' ');
  }

  it.each([
    ['an active account', ACTIVE_ORG],
    ['an account still in verification', { ...ACTIVE_ORG, stripe_charges_enabled: false, accepted_payment_methods: ['CASH'] }],
  ])('presents the online methods as ServWave Payments and never names the processor (%s)', async (_, org) => {
    const { container } = await renderPage({ ...org, tips_enabled: true });

    const online = screen.getByRole('group', { name: 'Online with ServWave Payments' });
    expect(online).toContainElement(screen.getByRole('switch', { name: 'Credit card' }));
    expect(online).toContainElement(screen.getByRole('switch', { name: 'Bank (ACH)' }));
    expect(everythingVisible(container)).not.toMatch(/stripe|klarna/i);
  });
});
