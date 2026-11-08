import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TaxRatesPage from '@/pages/settings/TaxRatesPage';
import { isImplausibleRateChange } from '@/components/tax/implausibleRateChange';
import * as api from '@/lib/api/org-tax-rates';

vi.mock('@/contexts/AbilityContext', () => ({
  useAppAbility: () => ({ can: () => true }),
}));

const rate = (over: Partial<api.OrgTaxRate> = {}): api.OrgTaxRate => ({
  id: 'otr-nj',
  name: 'New Jersey',
  rate: 0.066,
  state_code: 'NJ',
  is_visible: true,
  created_at: '2026-08-05T00:00:00Z',
  updated_at: '2026-08-05T00:00:00Z',
  ...over,
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TaxRatesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('isImplausibleRateChange', () => {
  it('passes a correction to a real local rate without prompting', () => {
    // 6.60 -> 6.625 is exactly the edit this feature exists for. Nagging here would train the
    // admin to click through the dialog, which is how the guard stops working.
    expect(isImplausibleRateChange(6.625, 6.6)).toBe(false);
  });

  it('catches the misplaced decimal point', () => {
    expect(isImplausibleRateChange(66, 6.6)).toBe(true);
  });

  it('catches a rate above any real US combined rate, even with no previous value', () => {
    // Louisiana, the national high, is 10.11%.
    expect(isImplausibleRateChange(20)).toBe(true);
    expect(isImplausibleRateChange(10.11)).toBe(false);
  });

  it('catches a large swing that stays under the ceiling', () => {
    expect(isImplausibleRateChange(12, 6.6)).toBe(true);
    expect(isImplausibleRateChange(9.5, 6.6)).toBe(false);
  });
});

describe('Settings -> Tax Rates', () => {
  it('lists hidden rates alongside visible ones, so a hidden state can be switched back on', () => {
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([
      rate(),
      rate({ id: 'otr-tx', name: 'Texas', rate: 0.082, state_code: 'TX', is_visible: false }),
    ]);

    renderPage();

    return waitFor(() => {
      expect(screen.getByText('Texas')).toBeInTheDocument();
      expect(screen.getByText('1 of 2 shown in dropdowns')).toBeInTheDocument();
    });
  });

  it('toggling the switch sends is_visible on its own', async () => {
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([rate()]);
    const update = vi.spyOn(api, 'updateOrgTaxRate').mockResolvedValue(rate({ is_visible: false }));

    renderPage();
    const toggle = await screen.findByLabelText('Show New Jersey in tax dropdowns');
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('otr-nj', {
        name: undefined,
        rate: undefined,
        is_visible: false,
      }),
    );
  });

  it('puts the caret in the rate field when the rate is what was clicked', async () => {
    // Both cells enter edit mode together, so an unconditional autoFocus on Name silently steals
    // the caret from the number the admin actually clicked.
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([rate()]);

    renderPage();
    await userEvent.click(await screen.findByText('6.600%'));

    expect(screen.getAllByRole('spinbutton')[0]).toHaveFocus();
  });

  it('puts the caret in the name field when the name is what was clicked', async () => {
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([rate()]);

    renderPage();
    await userEvent.click(await screen.findByText('New Jersey'));

    expect(screen.getByDisplayValue('New Jersey')).toHaveFocus();
  });

  it('sends nothing when a row is opened and closed without a change', async () => {
    // Clicking in and back out is not an edit. A PATCH here means a write plus a full refetch,
    // which is what makes an untouched row appear to reload on its own.
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([rate()]);
    const update = vi.spyOn(api, 'updateOrgTaxRate').mockResolvedValue(rate());

    renderPage();
    await userEvent.click(await screen.findByText('New Jersey'));
    fireEvent.blur(screen.getByDisplayValue('New Jersey'));

    await waitFor(() => expect(screen.getByText('New Jersey')).toBeInTheDocument());
    expect(update).not.toHaveBeenCalled();
  });

  it('shows the rate at the precision it stores, not a float artifact', async () => {
    // 0.0946 * 100 is 9.459999999999999. That must not be what lands in the edit field.
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([
      rate({ id: 'otr-al', name: 'Alabama', rate: 0.0946, state_code: 'AL' }),
    ]);

    renderPage();
    await userEvent.click(await screen.findByText('9.460%'));

    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(9.46);
  });

  it('asks before committing an implausible rate, and saves nothing if the admin backs out', async () => {
    vi.spyOn(api, 'listOrgTaxRates').mockResolvedValue([rate()]);
    const update = vi.spyOn(api, 'updateOrgTaxRate').mockResolvedValue(rate());

    renderPage();
    await userEvent.click(await screen.findByText('New Jersey'));

    // Two number inputs exist while editing: the row's rate, then the "add rate" field below it.
    const rateField = screen.getAllByRole('spinbutton')[0];
    fireEvent.change(rateField, { target: { value: '66' } });
    fireEvent.keyDown(rateField, { key: 'Enter' });

    await screen.findByTestId('confirm-rate-change-dialog');
    expect(update).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Go back' }));
    expect(update).not.toHaveBeenCalled();
  });
});
