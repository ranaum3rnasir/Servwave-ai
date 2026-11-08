/**
 * Customer notifications come only from automations (scheduling-notifications slice 01).
 *
 * VisitScheduleDialog used to host the hand-composed "Notify the customer" composer, defaulted
 * on, and every save through it carried an explicit `notify` object: a tick sent a one-off email
 * beside the org's own automation, an untick suppressed that automation for the occurrence. Two
 * senders for one message meant an admin could not say where the customer's email came from.
 *
 * Now the dialog books the trip and says nothing about email. The save body carries NO notify
 * key at all, which the visit routes read as "let the automation handle it". The routes still
 * accept the keys for other clients; only the web stops sending them.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import api from '@/lib/axios';
import { VisitScheduleDialog } from '@/pages/v2/jobs/components/visitScheduleDialog';

const post = api.post as ReturnType<typeof vi.fn>;

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VisitScheduleDialog
        open
        onOpenChange={() => {}}
        jobId="job-1"
        canAssignCrew={false}
      />
    </QueryClientProvider>,
  );
}

/** Fills the four required fields so the Book button is enabled, then blurs the last one. */
async function fillWindow(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Start date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('Start time'), '9:00 AM');
  await user.tab();
  await user.type(screen.getByLabelText('End date'), '09/01/2026');
  await user.tab();
  await user.type(screen.getByLabelText('End time'), '11:00 AM');
  await user.tab();
}

describe('VisitScheduleDialog - the customer is told by the automation, not by this dialog', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ data: {} });
  });

  it('offers no notify fields: no opt-out, no To, no Message', () => {
    renderDialog();

    expect(screen.queryByRole('checkbox', { name: 'Notify the customer' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
  });

  it('books the visit with a body that carries no notify key at all', async () => {
    const user = userEvent.setup();
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    // Absent, not `notify_customer: false`: an explicit decline would suppress the automation
    // for this occurrence, and the automation is now the only thing that tells the customer.
    expect(body).not.toHaveProperty('notify');
    expect(body).not.toHaveProperty('notify_customer');
  });

  // The write can still take seconds server-side (founder acceptance feedback: a grey-but-
  // unlabelled button read as stuck). Deliberately never resolves the post - the assertion is
  // on the busy render, not on what happens after it settles.
  it('shows the busy label and stays disabled while the save is still in flight', async () => {
    const user = userEvent.setup();
    post.mockReturnValue(new Promise(() => {}));
    renderDialog();

    await fillWindow(user);
    await user.click(screen.getByRole('button', { name: 'Book visit' }));

    const busyButton = await screen.findByRole('button', { name: 'Booking...' });
    expect(busyButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Book visit' })).not.toBeInTheDocument();
  });
});
