import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { partialMatchKey } from '@tanstack/react-query';

import { renderWithProviders } from '@/__tests__/helpers';
import { paymentsPageKeys } from '@/lib/api/paymentsPage';

import { DISPUTE_URL, DisputeStage } from './disputeHarness';
import { CAN_UPLOAD, openForm } from './disputeHarness';
import { apiError, file, inDays, inHours, makeEvidence, mockApi, serveDispute } from './disputeFixtures';

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
    renderWithProviders(<DisputeStage />, { ability: CAN_UPLOAD, initialEntries: [DISPUTE_URL] });
    await u.click(await screen.findByRole('button', { name: 'Respond' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Your explanation'), { target: { value: 'Typed, never saved' } });
    fireEvent.click(screen.getByText('stage-close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('stage-open'));
    // Back on the Dispute view, not the form, and the form is new.
    await u.click(await screen.findByRole('button', { name: 'Respond' }));
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

describe('the Dispute view deadline', () => {
  const tone = async (respondBy: string, over: Parameters<typeof makeEvidence>[0] = {}) => {
    mockApi.get.mockReset();
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: respondBy, days_left: 0 }, ...over }) });
    renderWithProviders(<DisputeStage />, { initialEntries: [DISPUTE_URL] });
  };
  const banner = async (text: string) => (await screen.findByText(text)).closest('[role="status"]');

  it('is calm at 5 days', async () => {
    await tone(inDays(5));
    expect(await banner('5 days left')).not.toHaveAttribute('data-tone', 'danger');
  });

  it('stays calm at 2 days and turns urgent only under 48 hours', async () => {
    await tone(inDays(2));
    expect(await banner('2 days left')).not.toHaveAttribute('data-tone', 'danger');
    cleanup();
    await tone(inHours(47));
    expect(await banner('47 hours left')).toHaveAttribute('data-tone', 'danger');
  });

  it('says 1 hour left, urgent, in the last hour while the response is still open', async () => {
    await tone(new Date(Date.now() + 1_800_000).toISOString());
    expect(await banner('1 hour left')).toHaveAttribute('data-tone', 'danger');
  });

  it('says Past due once the time has passed', async () => {
    await tone('2026-10-01T12:00:00.000Z', { can_edit: false });
    expect(await screen.findByText('Past due', { selector: 'div' })).toBeInTheDocument();
  });
});
