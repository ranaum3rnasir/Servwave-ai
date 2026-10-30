/**
 * Payments go-live slice W1 - Settings > Payments & Lists clean-up.
 *
 * Driven the way an owner drives the page: the saver the page hands the settings Save bar is the
 * real save path, and what is asserted is what the owner can see, focus and click.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';

let registeredSave: (() => Promise<void> | void) | null = null;
vi.mock('@/pages/v2/settings/settingsBar', async (orig) => ({
  ...(await orig<typeof import('@/pages/v2/settings/settingsBar')>()),
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      registeredSave = fns.save;
    },
  }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: vi.fn(() => ({ logout: vi.fn() })) }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ConnectAccountOnboarding: () => <div />,
  ConnectAccountManagement: () => <div />,
  ConnectNotificationBanner: () => <div />,
}));

const { default: ServwavePaymentsPage } = await import('@/pages/v2/settings/ServwavePaymentsPage');
const { default: ListsPage } = await import('@/pages/v2/settings/ListsPage');

const PAGE_ABILITY = buildAbility([
  { action: 'update', subject: 'Organization' },
  { action: 'manage_payout_account', subject: 'Organization' },
]);

const mockApi = vi.mocked(api);

const ORG = {
  id: 'o1',
  stripe_connected: true,
  stripe_charges_enabled: true,
  accepted_payment_methods: ['CARD', 'ACH', 'CASH'],
  card_offered_by_default: true,
  bank_offered_by_default: true,
  tips_enabled: true,
  tip_presets: [10, 15, 20],
  deposit_policy: 'REQUIRED_BEFORE_APPROVAL',
  bank_transfer_instructions: null,
  source_options: [],
  job_type_options: [],
  deposit_default_type: 'PERCENTAGE',
  deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

function serve(org: Record<string, unknown> = ORG) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: org });
    return Promise.resolve({ data: {} });
  });
}

async function renderPage(org: Record<string, unknown> = ORG, opts: { ability?: ReturnType<typeof buildAbility> } = {}) {
  serve(org);
  const user = userEvent.setup();
  const view = renderWithProviders(<ServwavePaymentsPage />, { ability: opts.ability ?? PAGE_ABILITY });
  await screen.findByDisplayValue('40');
  return { user, ...view };
}

/** The Lists half (Tags, Task categories) still lives on the trimmed lists page. */
async function renderLists(ability: ReturnType<typeof buildAbility>) {
  serve();
  const user = userEvent.setup();
  const view = renderWithProviders(<ListsPage />, { ability });
  await screen.findByText('Lead/Customer sources');
  return { user, ...view };
}

function cardOf(title: string): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('[data-slot="card"]') as HTMLElement;
}

async function setChoice(user: ReturnType<typeof userEvent.setup>, n: number, text: string) {
  const field = screen.getByRole('textbox', { name: `Choice ${n}` });
  await user.tripleClick(field);
  await user.keyboard(text === '' ? '{Backspace}' : text);
}

beforeEach(() => {
  vi.clearAllMocks();
  registeredSave = null;
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('W1 labels', () => {
  it('names the online methods "Credit card" and "Bank (ACH)"', async () => {
    await renderPage();
    expect(screen.getByRole('switch', { name: 'Credit card' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Bank (ACH)' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Bank' })).not.toBeInTheDocument();
  });
});

describe('W1 no redundant subtitles', () => {
  it('shows no description line under the three named headers', async () => {
    await renderPage(ORG, { ability: buildAbility([{ action: 'refund', subject: 'Invoice' }, { action: 'update', subject: 'Organization' }, { action: 'manage_payout_account', subject: 'Organization' }]) });
    // The attention list left Settings in P8 (its "no description line" check moves to the Payments page card).
    expect(screen.queryByRole('heading', { name: 'Payments needing attention' })).not.toBeInTheDocument();

    for (const title of ['Accepted payment methods', 'Default deposit', 'Tips']) {
      const heading = screen.getByRole('heading', { name: title });
      // The header block holds the title (and at most a "?" button), never a grey sentence.
      const header = heading.closest('.min-w-0') as HTMLElement;
      expect(header.querySelectorAll('p')).toHaveLength(1);
    }
    expect(screen.queryByText(/Shown to customers on public estimate/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Default deposit when sending/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tips are worked out/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing is refunded automatically/)).not.toBeInTheDocument();
  });

  it('a "?" next to Tips opens a popover with the own-amount sentence on click', async () => {
    const { user } = await renderPage();
    const sentence = /They can also enter their own amount or skip the tip\./;
    expect(screen.queryByText(sentence)).not.toBeInTheDocument();
    await user.click(within(cardOf('Tips')).getByRole('button', { name: /more about tips/i }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });
});

const LISTS_ABILITY = () =>
  buildAbility([
    { action: 'update', subject: 'Organization' },
    { action: 'update', subject: 'Tag' },
    { action: 'delete', subject: 'Tag' },
    { action: 'create', subject: 'TaskCategory' },
    { action: 'update', subject: 'TaskCategory' },
  ]);

describe('W1 Tags and Task categories cards', () => {
  it('show no grey description; the must-know line sits behind a "?"', async () => {
    const { user } = await renderLists(LISTS_ABILITY());
    for (const title of ['Tags', 'Task categories']) {
      const heading = await screen.findByRole('heading', { name: title });
      // The title block holds the title and its "?", never a sentence.
      expect((heading.parentElement as HTMLElement).querySelectorAll('p')).toHaveLength(1);
    }
    expect(screen.queryByText(/Tags used across customers/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Shown to everyone who can see a task/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more about tags/i }));
    expect(await screen.findByText('Labels you put on customers, jobs and leads to group and filter them.')).toBeInTheDocument();
  });

  it('the "?" trigger is a 44px tap target on a phone width', async () => {
    await renderLists(LISTS_ABILITY());
    const trigger = (await screen.findAllByRole('button', { name: /^more about/i }))[0];
    expect(trigger.className).toContain('max-sm:size-11');
    expect(trigger.className).toContain('touch:size-11');
  });
});

describe('W1 tips layout', () => {
  it('lays three labelled choices in one equal-width, spaced row that stacks on a phone', async () => {
    await renderPage();
    const row = screen.getByTestId('tip-presets-row');
    expect(row.className).toMatch(/grid-cols-1/);
    expect(row.className).toMatch(/sm:grid-cols-3/);
    expect(row.className).toMatch(/gap-3/);
    for (const n of [1, 2, 3]) {
      const field = screen.getByRole('textbox', { name: `Choice ${n}` });
      expect(row).toContainElement(field);
      expect(field.parentElement).toHaveTextContent('%');
    }
  });
});

describe('W1 tips validation and the failed-save trail', () => {
  it('an empty choice blocks the save, shows the message under the field and marks it', async () => {
    const { user } = await renderPage();
    await setChoice(user, 2, '');
    await expect(registeredSave?.()).rejects.toThrow();

    const field = screen.getByRole('textbox', { name: 'Choice 2' });
    await waitFor(() => expect(field).toHaveAttribute('aria-invalid', 'true'));
    expect(field.className).toMatch(/(^|\s)border-danger(\s|$)/);
    const message = await screen.findByText('Enter a whole number from 1 to 50.');
    expect(field).toHaveAccessibleDescription('Enter a whole number from 1 to 50.');
    expect(message).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('an out-of-range choice (150) blocks the save', async () => {
    const { user } = await renderPage();
    await setChoice(user, 3, '150');
    await expect(registeredSave?.()).rejects.toThrow();
    expect(await screen.findByText('Enter a whole number from 1 to 50.')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('a duplicate choice blocks the save and marks the repeated one', async () => {
    const { user } = await renderPage();
    await setChoice(user, 2, '10');
    await expect(registeredSave?.()).rejects.toThrow();
    expect(await screen.findByText('Each choice must be different.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Choice 2' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Choice 1' })).not.toHaveAttribute('aria-invalid', 'true');
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('Save scrolls to the first bad field and focuses it', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { user } = await renderPage();
    await setChoice(user, 2, '');
    await setChoice(user, 3, '99');
    await expect(registeredSave?.()).rejects.toThrow();

    expect(screen.getByRole('textbox', { name: 'Choice 2' })).toHaveFocus();
    expect(scroll).toHaveBeenCalled();
  });

  it('the summary shows from two bad fields on, counts them, and each line jumps to its field', async () => {
    const { user } = await renderPage();
    await setChoice(user, 2, '');
    await expect(registeredSave?.()).rejects.toThrow();
    // One bad field: the message under it is enough (spec 5.10 step 3).
    expect(await screen.findByText('Enter a whole number from 1 to 50.')).toBeInTheDocument();
    expect(screen.queryByText('Fix 1 field to save')).not.toBeInTheDocument();

    await setChoice(user, 3, '99');
    await expect(registeredSave?.()).rejects.toThrow();
    expect(await screen.findByText('Fix 2 fields to save')).toBeInTheDocument();

    screen.getByRole('textbox', { name: 'Choice 1' }).focus();
    const lines = within(screen.getByRole('alert')).getAllByRole('button');
    expect(lines).toHaveLength(2);
    await user.click(lines[0]!);
    expect(screen.getByRole('textbox', { name: 'Choice 2' })).toHaveFocus();
  });

  it('fixing a tip box clears the tip messages and the summary', async () => {
    const { user } = await renderPage();
    await setChoice(user, 2, '');
    await setChoice(user, 3, '99');
    await expect(registeredSave?.()).rejects.toThrow();
    await screen.findByText('Fix 2 fields to save');
    await user.keyboard('18');
    expect(screen.queryByText('Fix 2 fields to save')).not.toBeInTheDocument();
    expect(screen.queryByText('Enter a whole number from 1 to 50.')).not.toBeInTheDocument();
  });

  it('the same trail serves the deposit field', async () => {
    const { user } = await renderPage();
    const pct = screen.getByRole('textbox', { name: /Percentage/ });
    await user.tripleClick(pct);
    await user.keyboard('150');
    await expect(registeredSave?.()).rejects.toThrow();
    expect(pct).toHaveFocus();
    expect(await screen.findByText('Enter a deposit percentage between 0 and 100.')).toBeInTheDocument();
    expect(pct).toHaveAccessibleDescription('Enter a deposit percentage between 0 and 100.');
  });
});

// The W1 "refund confirm" cases (Refund asks first and calls nothing until confirmed; Cancel calls nothing) moved with the
// card: they are item 2 of the card-side list in payments-needing-attention-hooks.test.tsx.
