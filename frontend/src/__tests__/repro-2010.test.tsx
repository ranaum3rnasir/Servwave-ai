/**
 * Repro for #2010 — MarkSentDialog renders the deposit as static read-only text with no
 * input, while SendEstimateDialog exposes editable "Deposit %" / "Deposit amount" inputs for
 * the identical value on the same estimate and persists an edit via `PATCH /api/estimates/:id`
 * ({ deposit_type, deposit_value }) before it POSTs the send/mark-sent call.
 *
 * Both cases below pass against SendEstimateDialog today (see send-estimate-deposit.test.tsx)
 * and fail against MarkSentDialog, which is the asymmetry the issue reports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';

vi.mock('@/lib/axios', () => ({
  default: { post: vi.fn(), patch: vi.fn(), get: vi.fn() },
}));

const mockOrg = vi.fn();
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => mockOrg(),
}));

const TOTAL = 1000;

function renderDialog(props: Partial<React.ComponentProps<typeof MarkSentDialog>> = {}) {
  return renderWithProviders(
    <MarkSentDialog
      open
      onOpenChange={() => {}}
      estimateId="est-2010"
      estimateNumber="C00011-1"
      totalAmount={TOTAL}
      onSuccess={() => {}}
      {...props}
    />,
  );
}

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

describe('#2010 — Mark as Sent deposit block', () => {
  it('exposes an editable Deposit % input, not static text, for a $1,000 estimate at the 50% org default', () => {
    renderDialog();

    const dialog = screen.getByRole('dialog');
    // Sanity: the read-only figure the issue describes is on screen today.
    expect(within(dialog).getByText(/50%/)).toBeInTheDocument();

    // Same accessible name SendEstimateDialog uses for its live input
    // (SendEstimateDialog.tsx: <FormField label="Deposit %" htmlFor="send-deposit-pct">).
    // MarkSentDialog renders only a <p>, so this must fail today.
    expect(within(dialog).getByLabelText(/deposit %/i)).toBeInTheDocument();
  });

  it('persists an edited deposit via PATCH /api/estimates/:id before POSTing mark-sent', async () => {
    const user = userEvent.setup();
    renderDialog();

    const dialog = screen.getByRole('dialog');
    const pctInput = within(dialog).getByLabelText(/deposit %/i) as HTMLInputElement;

    await user.clear(pctInput);
    await user.type(pctInput, '25');
    await user.click(within(dialog).getByRole('button', { name: /mark as sent/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());

    // Same field names/enum SendEstimateDialog persists (SendEstimateDialog.tsx:243-248).
    expect(api.patch).toHaveBeenCalledWith('/api/estimates/est-2010', {
      deposit_type: 'PERCENTAGE',
      deposit_value: 25,
    });

    const patchOrder = (api.patch as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const postOrder = (api.post as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(patchOrder).toBeLessThan(postOrder);
  });
});
