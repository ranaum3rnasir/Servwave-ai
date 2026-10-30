import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { partialMatchKey } from '@tanstack/react-query';

import { renderWithProviders } from '@/__tests__/helpers';
import { paymentsPageKeys } from '@/lib/api/paymentsPage';

import { DisputeDrawer } from '../components/DisputeDrawer';
import { CAN_UPLOAD, openForm } from './disputeHarness';
import { DISPUTE_ID, apiError, file, inDays, makeEvidence, mockApi, serveDispute } from './disputeFixtures';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));
vi.mock('@/ui-kit/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
});

const ready = () => makeEvidence({
  can_submit: true,
  form: {
    version: 5,
    files: { receipt: file('a1', 'receipt.pdf') },
    text: { uncategorized_text: 'Done.', product_description: '', service_date: '2026-09-30', customer_name: 'Dana Whitfield', customer_email_address: 'dana@example.test' },
  },
});

describe('closing and reopening', () => {
  it('starts the form over from what the server holds when the drawer is closed and opened again', async () => {
    serveDispute();
    const u = userEvent.setup();
    const view = renderWithProviders(<DisputeDrawer disputeId={DISPUTE_ID} onClose={vi.fn()} />, { ability: CAN_UPLOAD });
    await u.click(await screen.findByRole('button', { name: 'Add evidence' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Your explanation'), { target: { value: 'Typed, never saved' } });
    view.rerender(<DisputeDrawer disputeId={null} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    view.rerender(<DisputeDrawer disputeId={DISPUTE_ID} onClose={vi.fn()} />);
    // Back on step 1, not step 2, and the form is new.
    await u.click(await screen.findByRole('button', { name: 'Add evidence' }));
    dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText('Your explanation')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: 'Submit evidence' })).toBeDisabled();
  });

  it('shows a clean confirm each time it is opened: an earlier failure is not carried over', async () => {
    serveDispute({ evidence: ready() });
    mockApi.post.mockRejectedValue(apiError(502, { error: 'We couldn\'t send this to the card network. Try again in a moment, or contact ServWave support.' }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Submit evidence' }));
    let ask = await screen.findByRole('dialog', { name: 'Submit evidence' });
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    expect(await within(ask).findByText(/We couldn't send this to the card network/)).toBeInTheDocument();
    await u.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submit evidence' })).not.toBeInTheDocument());
    await u.click(within(dialog).getByRole('button', { name: 'Submit evidence' }));
    ask = await screen.findByRole('dialog', { name: 'Submit evidence' });
    expect(within(ask).queryByText(/We couldn't send this to the card network/)).not.toBeInTheDocument();
    expect(within(ask).getByRole('button', { name: 'Submit evidence' })).toBeEnabled();
  });
});

describe('after Submit, every payment view is marked stale', () => {
  it('invalidates the attention view, the list, the summary and the payment detail', async () => {
    serveDispute({ evidence: ready() });
    mockApi.post.mockResolvedValue({ data: makeEvidence({ dispute: { status: 'UNDER_REVIEW' }, can_edit: false, submitted: { at: '2026-10-14T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [] } }) });
    const { u, dialog, queryClient } = await openForm();
    const keys = {
      attention: paymentsPageKeys.attention('org-1', 'open', {}),
      list: paymentsPageKeys.list('org-1', { from: 'a', to: 'b' }),
      summary: paymentsPageKeys.summary('org-1', 'a', 'b'),
      detail: paymentsPageKeys.detail('org-1', 'pay-1'),
    };
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    await u.click(within(dialog).getByRole('button', { name: 'Submit evidence' }));
    const ask = await screen.findByRole('dialog', { name: 'Submit evidence' });
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // A filter counts when it is a prefix of the view's key, which is how the cache decides what to mark stale.
    const invalidated = (key: readonly unknown[]) =>
      spy.mock.calls.some(([f]) => Array.isArray(f?.queryKey) && partialMatchKey(key as never, f.queryKey as never));
    for (const [name, k] of Object.entries(keys)) expect(invalidated(k), name).toBe(true);
    expect(invalidated(['some-other-view', 'org-1'])).toBe(false);
  });
});

describe('step 1 deadline', () => {
  const tone = async (days: number | null, over: Parameters<typeof makeEvidence>[0] = {}) => {
    mockApi.get.mockReset();
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: days === null ? null : inDays(days), days_left: days }, ...over }) });
    renderWithProviders(<DisputeDrawer disputeId={DISPUTE_ID} onClose={vi.fn()} />);
  };

  it('is calm at 5 days', async () => {
    await tone(5);
    expect(await screen.findByText('5 days left')).not.toHaveAttribute('data-tone', 'danger');
  });

  it('turns urgent at 2 days', async () => {
    await tone(2);
    expect(await screen.findByText('2 days left')).toHaveAttribute('data-tone', 'danger');
  });

  it('says Due today at 0 days, urgent, while the response is still open', async () => {
    await tone(0, { dispute: { respond_by: new Date(Date.now() + 3_600_000).toISOString(), days_left: 0 } });
    expect(await screen.findByText('Due today')).toHaveAttribute('data-tone', 'danger');
  });

  it('says the deadline passed once it is past', async () => {
    await tone(0, { dispute: { respond_by: '2026-10-01T12:00:00.000Z', days_left: 0 }, can_edit: false });
    expect(await screen.findByText('The deadline passed on Oct 1, 2026')).toBeInTheDocument();
  });
});

