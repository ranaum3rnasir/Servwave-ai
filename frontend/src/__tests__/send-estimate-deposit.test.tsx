/**
 * SendEstimateDialog - the deposit block.
 *
 * The bug this guards: the dialog computed its deposit preview from the ORG defaults alone, while
 * the send endpoint charges what `resolveDepositAmount` returns - which PREFERS the estimate's own
 * deposit_type/deposit_value (the Receipt Card override). An estimate overridden to 70% under a
 * 50% org default previewed $53.32 and billed $74.64.
 *
 * Plus the new behaviour: the figure is editable pre-send and persists through the same PATCH the
 * Receipt Card uses (the send endpoint takes no deposit argument), and is read-only once billed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { SendEstimateDialog } from '@/components/estimates/SendEstimateDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

vi.mock('@/components/payments/StripePaymentsBanner', () => ({
  StripePaymentsBanner: () => null,
}));

const TOTAL = 106.63;

function renderDialog(props: Partial<React.ComponentProps<typeof SendEstimateDialog>> = {}) {
  return renderWithProviders(
    <SendEstimateDialog
      open
      onOpenChange={() => {}}
      estimateId="est-1"
      estimateNumber="J00229-2"
      totalAmount={TOTAL}
      customerEmail="art.nakamura@example.com"
      alreadySent={false}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

const pctInput = () => screen.getByLabelText(/deposit %/i) as HTMLInputElement;
const amtInput = () => screen.getByLabelText(/deposit amount/i) as HTMLInputElement;
const sendButton = () => screen.getByRole('button', { name: /send j00229-2/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockOrg.mockReturnValue({
    data: {
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      accepted_payment_methods: ['EXTERNAL_CARD'],
    },
  });
  (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
  (api.patch as ReturnType<typeof vi.fn>).mockResolvedValue({ data: {} });
});

describe('deposit preview', () => {
  it('honours the estimate override instead of the org default', () => {
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });
    expect(pctInput().value).toBe('70'); // not the org's 50
    expect(amtInput().value).toBe('74.64'); // not 53.32, and not 74.64099999999999
  });

  it('falls back to the org default when the estimate has no override', () => {
    renderDialog();
    expect(pctInput().value).toBe('50');
    expect(amtInput().value).toBe('53.32');
  });

  it('shows the billed figure once a deposit has been sent', () => {
    renderDialog({
      depositType: 'PERCENTAGE',
      depositValue: 70,
      depositFrozen: true,
      existingDepositAmount: 26.66,
      existingDepositPercentage: 25,
    });
    expect(pctInput().value).toBe('25');
    expect(amtInput().value).toBe('26.66');
  });
});

describe('editing the deposit', () => {
  it('mirrors the percentage into the amount and back', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(pctInput());
    await user.type(pctInput(), '25');
    expect(amtInput().value).toBe('26.66');

    await user.clear(amtInput());
    await user.type(amtInput(), '40');
    expect(pctInput().value).toBe('37.51');
  });

  it('persists a changed percentage as PERCENTAGE before sending', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(pctInput());
    await user.type(pctInput(), '25');
    await user.click(sendButton());

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith('/api/estimates/est-1', {
      deposit_type: 'PERCENTAGE',
      deposit_value: 25,
    });
  });

  it('persists a typed dollar figure as FIXED, not as a percentage', async () => {
    // Storing one mode for both would silently flip the estimate's deposit type under the
    // Receipt Card that displays it.
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(amtInput());
    await user.type(amtInput(), '40');
    await user.click(sendButton());

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.patch).toHaveBeenCalledWith('/api/estimates/est-1', {
      deposit_type: 'FIXED',
      deposit_value: 40,
    });
  });

  it('does not PATCH when the deposit was left alone', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.click(sendButton());

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('aborts the send when persisting the deposit fails', async () => {
    // Sending anyway would bill a deposit different from the one on screen.
    (api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'));
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(pctInput());
    await user.type(pctInput(), '25');
    await user.click(sendButton());

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('blocks a deposit larger than the estimate total', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.clear(amtInput());
    await user.type(amtInput(), '500');

    expect(sendButton()).toBeDisabled();
  });

  it('is read-only once the deposit has been billed', () => {
    renderDialog({
      depositFrozen: true,
      existingDepositAmount: 74.64,
      existingDepositPercentage: 70,
    });
    expect(pctInput()).toBeDisabled();
    expect(amtInput()).toBeDisabled();
  });

  it('hides the deposit fields when the toggle is off', async () => {
    const user = userEvent.setup();
    renderDialog({ depositType: 'PERCENTAGE', depositValue: 70 });

    await user.click(screen.getByRole('switch', { name: /require deposit/i }));

    expect(screen.queryByLabelText(/deposit %/i)).not.toBeInTheDocument();
  });
});
