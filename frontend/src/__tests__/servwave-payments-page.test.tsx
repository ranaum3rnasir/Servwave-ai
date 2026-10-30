/**
 * Settings > ServWave Payments (V7-02b): the seven cards, the verification rows, the plan card, gating, the hash
 * arrival and the new validation rules. Cards 3 to 7 keep their older cases in settings-payment-defaults,
 * settings-payments-cleanup and settings-payments-plan-gate; the status states in stripe-payments-status-card; the
 * payout card in servwave-payments-payout-card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import type { StripeStatus } from '@/lib/api/organization';

const saver = vi.hoisted(() => ({
  current: null as null | { save: () => Promise<void> | void; discard: () => void; isDirty: boolean },
  registrations: 0,
}));
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void; discard: () => void; isDirty: boolean }) => {
      saver.current = fns;
      saver.registrations += 1;
    },
  }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div data-testid="embedded-onboarding" />,
  ConnectAccountManagement: () => <div data-testid="embedded-management" />,
  ConnectNotificationBanner: () => <div />,
}));
const plan = vi.hoisted(() => ({ online: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => plan.online,
}));

const { default: ServwavePaymentsPage } = await import('@/pages/v2/settings/ServwavePaymentsPage');

const mockApi = vi.mocked(api);

const FULL = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);
const PAYOUT_ONLY = buildAbility([{ action: 'manage_payout_account', subject: 'Organization' }]);
const SETTINGS_ONLY = buildAbility([{ action: 'update', subject: 'Organization' }]);

const ORG = {
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
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

const ACTIVE: StripeStatus = {
  connected: true,
  terms_accepted: true,
  stripe_charges_enabled: true,
  stripe_payouts_enabled: true,
  stripe_details_submitted: true,
  stripe_requirements_due: [],
  stripe_disabled_reason: null,
  collected_awaiting_payout: 0,
  verification: { business_details: 'verified', owner_identity: 'verified', bank_account: 'verified', tax_id: 'verified' },
};

function serve(status: Partial<StripeStatus> = {}, org: Record<string, unknown> = ORG) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: org });
    if (url === '/api/organization/stripe/status') return Promise.resolve({ data: { ...ACTIVE, ...status } });
    if (url === '/api/organization/stripe/statement-descriptor') return Promise.resolve({ data: { statement_descriptor: 'HARBOR LOCKS' } });
    return Promise.resolve({ data: {} });
  });
}

async function renderPage(ability = FULL, entries?: string[]) {
  const user = userEvent.setup();
  const view = renderWithProviders(<ServwavePaymentsPage />, { ability, ...(entries ? { initialEntries: entries } : {}) });
  await screen.findByRole('heading', { name: 'Payout account & verification' });
  // Both reads have landed: the status (card 2 body) and the org (the form has hydrated).
  await screen.findByText(/you may be asked for a verification code/);
  if (ability.can('update', 'Organization')) await screen.findByDisplayValue('40');
  return { user, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  saver.current = null;
  saver.registrations = 0;
  plan.online = true;
  localStorage.clear();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
  serve();
});

describe('the seven cards', () => {
  const CARDS: Array<[string, string]> = [
    ['ServWave Payments', 'Whether ServWave Payments is on for your account, and what is needed next.'],
    ['Payout account & verification', 'Where your customer payments are paid out to. Your bank and identity details are entered in a secure form and never pass through ServWave.'],
    ['Accepted payment methods', 'The ways customers can pay an invoice. Card and bank (ACH) are paid online through ServWave Payments. The rest are payments you record by hand.'],
    ['Default deposit', 'The deposit asked for on a new estimate, unless you change it on that estimate.'],
    ['Tips', 'A gratuity customers can add when they pay an invoice. They can also enter their own amount or skip the tip.'],
    ['Bank-transfer instructions', 'Shown to customers who choose to pay by bank transfer. Transfers are not tracked automatically: when one arrives, record the payment on the invoice yourself.'],
    ['Payment terms', 'The wording about when payment is due, printed on estimates and invoices.'],
  ];

  it('renders in order with the exact titles, each ending in a "?" and carrying no subtitle', async () => {
    await renderPage();
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(CARDS.map(([t]) => t));
    for (const [title] of CARDS) {
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.closest('.min-w-0')!.querySelectorAll('p')).toHaveLength(1);
      expect(within(heading.closest('.min-w-0') as HTMLElement).getByRole('button', { name: `More about ${title}` })).toBeInTheDocument();
    }
    const ids = ['sec-status', 'sec-payout', 'sec-methods', 'sec-deposit', 'sec-tips', 'sec-bank', 'sec-related'];
    expect(ids.map((id) => document.getElementById(id) !== null)).toEqual(ids.map(() => true));
  });

  it.each(CARDS)('the "?" on %s opens its text on click', async (title, text) => {
    const { user } = await renderPage();
    expect(screen.queryByText(text)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: `More about ${title}` }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByText(text)).not.toBeInTheDocument());
  });

  it('card 7 is one row with a badge and a new-tab link, and no form field', async () => {
    await renderPage();
    const card = document.getElementById('sec-related')!;
    expect(within(card).getByText('Estimate and invoice payment terms')).toBeInTheDocument();
    expect(within(card).getByText('Edited elsewhere')).toBeInTheDocument();
    const link = within(card).getByRole('link', { name: /^Open Branding & Templates/ });
    expect(link).toHaveAttribute('href', '/settings/branding');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(card.querySelectorAll('input, textarea')).toHaveLength(0);
  });

  it('card 3 offers the eight hand-recorded methods in the written order', async () => {
    await renderPage();
    const group = screen.getByRole('group', { name: 'Recorded by hand' });
    const labels = within(group).getAllByRole('checkbox').map((c) => c.closest('label')!.textContent);
    expect(labels).toEqual(['Card (outside ServWave)', 'Bank transfer', 'Check', 'Cash', 'Zelle', 'Venmo', 'Cash App', 'Other']);
  });
});

describe('the verification rows', () => {
  it.each([
    ['verified', 'Verified'],
    ['pending', 'Pending'],
    ['not_started', 'Not started'],
    ['action_needed', 'Action needed'],
    ['restricted', 'Restricted'],
  ] as const)('renders %s as the pill %s on every row', async (value, label) => {
    serve({
      stripe_requirements_due: [],
      verification: { business_details: value, owner_identity: value, bank_account: value, tax_id: value },
    });
    await renderPage();
    const list = screen.getByText('Verification').parentElement as HTMLElement;
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      `Business details${label}`,
      `Owner identity${label}`,
      `Bank account${label}`,
      `Tax ID${label}`,
    ]);
  });

  it('draws a check for verified, a clock for not started and an alert for anything else', async () => {
    serve({ verification: { business_details: 'verified', owner_identity: 'not_started', bank_account: 'action_needed', tax_id: 'pending' } });
    await renderPage();
    const icons = within(screen.getByText('Verification').parentElement as HTMLElement)
      .getAllByRole('listitem')
      .map((r) => r.querySelector('svg')!.getAttribute('class') ?? '');
    expect(icons[0]).toMatch(/lucide-check/);
    expect(icons[1]).toMatch(/lucide-clock/);
    expect(icons[2]).toMatch(/lucide-triangle-alert/);
    expect(icons[3]).toMatch(/lucide-triangle-alert/);
  });

  it.each([[null], [undefined]])('shows no rows and no error while verification is %s (not read yet)', async (value) => {
    serve({ verification: value as null });
    await renderPage();
    expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    expect(screen.queryByText('Business details')).not.toBeInTheDocument();
    expect(screen.getByText('Your payout account is active.')).toBeInTheDocument();
  });

  it('shows no rows for an unavailable account (state 8)', async () => {
    serve({ stripe_disabled_reason: 'rejected.fraud' });
    await renderPage();
    expect(screen.queryByText('Verification')).not.toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
    expect(screen.getByText('This account cannot receive payments. Contact ServWave support.')).toBeInTheDocument();
  });
});

describe('Set up payments, Resume setup and Fix now', () => {
  it('scroll to the payout card, focus its heading and leave the address alone (state 6)', async () => {
    serve({ stripe_requirements_due: ['individual.id_number'] });
    const { user } = await renderPage(FULL, ['/settings/servwave-payments']);
    await user.click(screen.getByRole('button', { name: 'Fix now' }));
    const heading = screen.getByRole('heading', { name: 'Payout account & verification' });
    expect(heading).toHaveFocus();
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('arrival at #payout-account scrolls and focuses the heading', async () => {
    serve();
    await renderPage(FULL, ['/settings/servwave-payments#payout-account']);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Payout account & verification' })).toHaveFocus());
  });

  it('a plain arrival leaves focus alone', async () => {
    await renderPage(FULL, ['/settings/servwave-payments']);
    expect(screen.getByRole('heading', { name: 'Payout account & verification' })).not.toHaveFocus();
  });
});

describe('who sees what (spec 5.12 check 10)', () => {
  it('a payout-only person sees cards 1 and 2 and registers no saver, so there is no Save bar', async () => {
    await renderPage(PAYOUT_ONLY);
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'ServWave Payments',
      'Payout account & verification',
    ]);
    expect(saver.registrations).toBe(0);
  });

  it('a settings-only person sees all seven cards, no action buttons on 1 and 2, and the Save bar saver', async () => {
    serve({ stripe_requirements_due: ['individual.id_number'] });
    await renderPage(SETTINGS_ONLY);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(7);
    expect(screen.queryByRole('button', { name: /fix now|finish setup|set up payments|connect bank|manage bank/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('embedded-onboarding')).not.toBeInTheDocument();
    expect(saver.registrations).toBeGreaterThan(0);
  });

  it('a person with neither switch gets the no-access page', () => {
    renderWithProviders(<ServwavePaymentsPage />, { ability: buildAbility([]) });
    expect(screen.queryByRole('heading', { name: 'ServWave Payments' })).not.toBeInTheDocument();
  });
});

describe('the plan card', () => {
  it('replaces the status when the plan has no online payments, and sits under "Your plan" beside an account', async () => {
    plan.online = false;
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Your plan' })).toBeInTheDocument();
    expect(screen.queryByText('Active', { selector: 'span' })).toBeNull();
    const upgrade = screen.getByRole('link', { name: /^Contact us to upgrade/ });
    expect(upgrade).toHaveAttribute('href', 'mailto:support@servwave.com?subject=ServWave plan upgrade');
    expect(upgrade).toHaveAttribute('target', '_blank');
  });
});

describe('deposit rules', () => {
  const save = async () => saver.current!.save();

  it('refuses an empty percentage, and the message names the 0-100 range', async () => {
    const { user } = await renderPage();
    const pct = screen.getByRole('textbox', { name: /Percentage/ });
    await user.clear(pct);
    await expect(save()).rejects.toThrow();
    expect(await screen.findByText('Enter a deposit percentage between 0 and 100.')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('typing 101 and saving sends nothing, focuses the field and shows the message', async () => {
    const { user } = await renderPage();
    const pct = screen.getByRole('textbox', { name: /Percentage/ });
    await user.tripleClick(pct);
    await user.keyboard('101');
    await expect(save()).rejects.toThrow();
    expect(pct).toHaveFocus();
    expect(await screen.findByText('Enter a deposit percentage between 0 and 100.')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('uses the new fixed-amount sentence, and refuses empty and over 99,999,999', async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'Fixed amount' }));
    const fixed = screen.getByRole('textbox', { name: 'Fixed amount' });
    await user.clear(fixed);
    await expect(save()).rejects.toThrow();
    expect(await screen.findByText('Enter a fixed deposit amount of $0.00 or more.')).toBeInTheDocument();

    await user.type(fixed, '100000000');
    await expect(save()).rejects.toThrow();
    expect(await screen.findByText('Enter a fixed deposit amount of $0.00 or more.')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(screen.queryByText(/valid fixed deposit amount/)).not.toBeInTheDocument();
  });

  it('accepts a fixed amount of 0 and sends it', async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'Fixed amount' }));
    await user.clear(screen.getByRole('textbox', { name: 'Fixed amount' }));
    await user.type(screen.getByRole('textbox', { name: 'Fixed amount' }), '0');
    await save();
    // 0 is a valid amount and equals the saved one, so only the type is dirty.
    expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', { deposit_default_type: 'FIXED' });
  });
});

describe('tips and the discard path', () => {
  it('turning tips on marks the form dirty; Discard turns it off again', async () => {
    const { user } = await renderPage();
    const tips = screen.getByRole('switch', { name: 'Let customers add a tip' });
    expect(tips).not.toBeChecked();
    await user.click(tips);
    expect(tips).toBeChecked();
    await waitFor(() => expect(saver.current!.isDirty).toBe(true));
    saver.current!.discard();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Let customers add a tip' })).not.toBeChecked());
  });

  it('clearing choices 2 and 3 as well as a bad percentage gives "Fix 3 fields to save" with jump lines', async () => {
    const { user } = await renderPage(FULL);
    await user.click(screen.getByRole('switch', { name: 'Let customers add a tip' }));
    const pct = screen.getByRole('textbox', { name: /Percentage/ });
    await user.tripleClick(pct);
    await user.keyboard('101');
    for (const n of [2, 3]) {
      const field = screen.getByRole('textbox', { name: `Choice ${n}` });
      await user.tripleClick(field);
      await user.keyboard('{Backspace}');
    }
    await expect(saver.current!.save()).rejects.toThrow();
    expect(await screen.findByText('Fix 3 fields to save')).toBeInTheDocument();
    const lines = within(screen.getByRole('alert')).getAllByRole('button');
    expect(lines).toHaveLength(3);
    await user.click(lines[2]!);
    expect(screen.getByRole('textbox', { name: 'Choice 3' })).toHaveFocus();
  });
});

describe('bank-transfer instructions', () => {
  it('has a visible label, a 5-row textarea and a counter that turns red over 5,000 characters', async () => {
    const { user } = await renderPage();
    const field = screen.getByRole('textbox', { name: 'Instructions customers see' });
    expect(field).toHaveAttribute('rows', '5');
    expect(field).toHaveAttribute('placeholder', 'Account name, routing and account numbers, and the reference to use');
    const label = screen.getByText('Instructions customers see', { selector: 'label' });
    expect(label.className).not.toContain('sr-only');
    const counter = screen.getByTestId('bank-instructions-counter');
    expect(counter).toHaveTextContent('0 of 5,000');
    await user.click(field);
    await user.paste('x'.repeat(5000));
    expect(counter).toHaveTextContent('5,000 of 5,000');
    expect(counter.className).not.toContain('text-danger');
    await user.paste('x');
    expect(counter).toHaveTextContent('5,001 of 5,000');
    expect(counter.className).toContain('text-danger');
    expect(counter.className).toContain('font-semibold');
  });

  it('refuses 5,001 characters on Save with the written message and sends nothing', async () => {
    const { user } = await renderPage();
    const field = screen.getByRole('textbox', { name: 'Instructions customers see' });
    await user.click(field);
    await user.paste('x'.repeat(5001));
    await expect(saver.current!.save()).rejects.toThrow();
    expect(await screen.findByText('Use 5,000 characters or fewer.')).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

describe('the unavailable online methods', () => {
  it('stay focusable (aria-disabled), name the reason, and ignore a click', async () => {
    serve({ stripe_charges_enabled: false }, { ...ORG, stripe_charges_enabled: false, accepted_payment_methods: ['CASH'] });
    const { user } = await renderPage();
    const card = screen.getByRole('switch', { name: 'Credit card' });
    expect(card).toHaveAttribute('aria-disabled', 'true');
    expect(card).not.toBeDisabled();
    expect(card).toHaveAccessibleDescription('Finish payout account verification first.');
    await user.click(card);
    expect(card).toBeChecked();
    expect(saver.current!.isDirty).toBe(false);
  });
});

describe('what the page never says', () => {
  it('names no vendor and prints no account id in the text or any attribute', async () => {
    const { container } = await renderPage();
    const parts = [container.textContent ?? ''];
    for (const el of container.querySelectorAll('*')) for (const a of el.attributes) if (a.name !== 'class') parts.push(a.value);
    expect(parts.join(' ')).not.toMatch(/stripe|acct_/i);
  });
});


describe('fix round 1: hidden invalid fields and the summary lines', () => {
  it('a cleared percentage is dropped from the payload once the type is switched to Fixed amount', async () => {
    const { user } = await renderPage();
    await user.clear(screen.getByRole('textbox', { name: /Percentage/ }));
    await user.click(screen.getByRole('radio', { name: 'Fixed amount' }));
    const fixed = screen.getByRole('textbox', { name: 'Fixed amount' });
    await user.clear(fixed);
    await user.type(fixed, '250');
    await saver.current!.save();
    expect(mockApi.patch).toHaveBeenCalledWith('/api/organization', {
      deposit_default_type: 'FIXED',
      deposit_default_fixed_amount: 250,
    });
  });

  it('a cleared fixed amount is dropped once the type is switched back to Percentage', async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole('radio', { name: 'Fixed amount' }));
    await user.clear(screen.getByRole('textbox', { name: 'Fixed amount' }));
    await user.click(screen.getByRole('radio', { name: 'Percentage' }));
    const pct = screen.getByRole('textbox', { name: /Percentage/ });
    await user.tripleClick(pct);
    await user.keyboard('25');
    await saver.current!.save();
    const sent = mockApi.patch.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(sent).toEqual({ deposit_default_percentage: 25 });
  });

  it('each summary line names its field, so two tip errors do not read the same', async () => {
    const { user } = await renderPage();
    await user.click(screen.getByRole('switch', { name: 'Let customers add a tip' }));
    for (const n of [2, 3]) {
      await user.tripleClick(screen.getByRole('textbox', { name: `Choice ${n}` }));
      await user.keyboard('{Backspace}');
    }
    await expect(saver.current!.save()).rejects.toThrow();
    await screen.findByText('Fix 2 fields to save');
    const lines = within(screen.getByRole('alert')).getAllByRole('button').map((b) => b.textContent);
    expect(lines).toEqual([
      'Tip choice 2: Enter a whole number from 1 to 50.',
      'Tip choice 3: Enter a whole number from 1 to 50.',
    ]);
  });
});
