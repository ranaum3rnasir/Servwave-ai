// "Reach sales" used to be a lie: the composer toasted "Email sent to sales"
// and threw the message away - no request left the browser, and the address it
// showed was the wrong company's. Both are asserted here, because the toast
// alone cannot tell a real send from the old fake one.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';

const post = vi.hoisted(() => vi.fn());

vi.mock('@/lib/axios', () => ({ default: { post } }));

vi.mock('@/lib/api/communication', () => ({
  useCommUsage: () => ({
    data: {
      cycleLabel: 'Aug 1 - 31',
      calling: { used: 147, limit: 100, unit: 'min' },
      texting: { used: 3, limit: 500, unit: 'texts' },
    },
    isError: false,
  }),
}));

import { PlanUsage } from '../components/planUsage';

async function openComposer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /plan usage/i }));
  await user.click(await screen.findByRole('button', { name: /reach sales/i }));
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: { status: 'sent', to: 'info@servwave.com' } });
});

describe('PlanUsage - Reach sales', () => {
  it('names info@servwave.com as the sales address on the panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={vi.fn()} branch="Main" />);

    await user.click(screen.getByRole('button', { name: /plan usage/i }));
    expect(await screen.findByText(/Sales: info@servwave\.com/)).toBeInTheDocument();
    expect(screen.queryByText(/northwind\.com/)).not.toBeInTheDocument();
  });

  it('asks for a subject and a question, and nothing else', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={vi.fn()} branch="Main" />);
    await openComposer(user);

    expect(await screen.findByLabelText(/Subject/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/What would you like to ask/i)).toBeInTheDocument();
    // Both ends of the message are the server's to decide, so neither is shown:
    // a To the sender cannot change, and a From that was ignored on submit.
    expect(screen.queryByLabelText(/^From$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^To$/)).not.toBeInTheDocument();
    expect(screen.queryByText('info@servwave.com')).not.toBeInTheDocument();
  });

  it('actually posts the message instead of only toasting', async () => {
    const onToast = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={onToast} branch="Main" />);
    await openComposer(user);

    await user.type(screen.getByLabelText(/What would you like to ask/i), 'Please raise our limits.');
    await user.click(screen.getByRole('button', { name: /send to sales/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0] as [string, Record<string, string>];
    expect(url).toBe('/api/support/sales-request');
    expect(body.message).toBe('Please raise our limits.');
    // The client names no reply address - the server uses the signed-in account.
    expect(body.replyTo).toBeUndefined();
    expect(body.subject).toBe('Phone plan question (Main)');
    // Nothing was picked, so there is no preset to report - the server labels it
    // a custom message rather than guessing one.
    expect(body.topic).toBeNull();
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining('sent to sales')));
  });

  it('reports which preset question was picked, so the inbox sees the ask', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={vi.fn()} branch="Main" />);
    await openComposer(user);

    await user.click(screen.getByRole('button', { name: /raise call\/text limits/i }));
    await user.click(screen.getByRole('button', { name: /send to sales/i }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, body] = post.mock.calls[0] as [string, Record<string, string>];
    expect(body.topic).toBe('limits');
    expect(body.subject).toBe('Increase call / text limits (Main)');
  });

  it('does not claim success when the send fails, and keeps the written message', async () => {
    post.mockRejectedValue(new Error('network down'));
    const onToast = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={onToast} branch="Main" />);
    await openComposer(user);

    const box = screen.getByLabelText(/What would you like to ask/i);
    await user.type(box, 'Please raise our limits.');
    await user.click(screen.getByRole('button', { name: /send to sales/i }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining("couldn't send")),
    );
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining('sent to sales'));
    expect(box).toHaveValue('Please raise our limits.');
  });
  // The server distinguishes a permanent block (409) from a transient outage
  // (502), but that is wasted if the dialog overwrites it with its own retry
  // line. An owner told to "try again shortly" on a failure that repeats
  // identically will keep retrying and keep failing - the exact loop the org
  // kill switch produced.
  it('surfaces the server-s own reason instead of always saying to try again', async () => {
    post.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error:
            "We couldn't deliver your message to our sales inbox. Please email info@servwave.com directly.",
        },
      },
    });
    const onToast = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<PlanUsage onToast={onToast} branch="Main" />);
    await openComposer(user);

    await user.type(screen.getByLabelText(/What would you like to ask/i), 'Please raise our limits.');
    await user.click(screen.getByRole('button', { name: /send to sales/i }));

    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('info@servwave.com directly')),
    );
    expect(onToast).not.toHaveBeenCalledWith(expect.stringContaining('try again'));
  });
});
