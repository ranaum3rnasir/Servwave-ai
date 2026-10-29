/**
 * The reset page (password reset spec §5.1 step 4, §5.2 "Token in the URL"; conductor brief §3.3).
 *
 * Seams: what the user sees, the address bar (window.location / history), the document's referrer
 * policy, and the request the page makes (the app's axios instance, mocked in the vitest setup).
 * Every token and password is generated per run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import ResetPasswordPage from '@/pages/v2/auth-public/ResetPasswordPage';

const secret = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const INVALID = 'This reset link is invalid or has expired.';
const BREACHED = "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one.";

let token: string;

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

/** Open the page the way the email link does: the token in the real address bar and the router. */
function openLink(search: string) {
  window.history.replaceState(null, '', `/reset-password${search}`);
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/login" element={<p>login page</p>} />
        <Route path="/forgot-password" element={<p>forgot page</p>} />
      </Routes>
      <Where />
    </>,
    { initialEntries: [`/reset-password${search}`] },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  token = secret();
  vi.mocked(api.post).mockResolvedValue({ data: { ok: true, sessions_signed_out: true } });
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

async function choose(user: ReturnType<typeof userEvent.setup>, password: string, confirm = password) {
  await user.type(screen.getByLabelText('New password'), password);
  await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Update password' }));
}

describe('reset page', () => {
  it('shows the new-password form for a link with a token', () => {
    openLink(`?token=${token}`);
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(2);
    expect(screen.getByText("At least 8 characters. Don't reuse a password from another site.")).toBeInTheDocument();
  });

  it('strips the token from the address bar as soon as it opens', async () => {
    openLink(`?token=${token}`);
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(token);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/reset-password$/));
  });

  it('sends the token in the request body only, and lands on sign-in with the notice flag', async () => {
    const user = userEvent.setup();
    openLink(`?token=${token}`);
    const password = secret();

    await choose(user, password);

    expect(api.post).toHaveBeenCalledWith('/api/auth/password/reset', { token, password }, { silentErrors: true });
    const url = vi.mocked(api.post).mock.calls[0]![0];
    expect(url).not.toContain(token);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?reset=1'));
  });

  it('asks the browser not to send this page as a referrer', () => {
    const { unmount } = openLink(`?token=${token}`);
    expect(document.querySelector('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    unmount();
  });

  it('opened with no token (e.g. a reload after the token was stripped), asks for the email link again', async () => {
    const user = userEvent.setup();
    openLink('');

    expect(screen.getByText('Open the reset link from your email again, or send a new link.')).toBeInTheDocument();
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/forgot-password');
  });

  it('when other devices could not be signed out, lands on sign-in with that flag', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true, sessions_signed_out: false } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?reset=1&others=1'));
  });

  it('an answer that does not confirm the sign-out is treated as not signed out', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { ok: true } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?reset=1&others=1'));
  });

  it('a used or expired link shows the invalid state when the server says so', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 400, data: { error: INVALID, code: 'invalid_reset_link' } } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());

    expect(await screen.findByText(INVALID)).toBeInTheDocument();
    expect(screen.queryByText(/Open the reset link from your email again/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send a new link' })).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('a breached password shows the ServWave message, swaps in the replacement token, and the retry succeeds', async () => {
    const replacement = secret();
    const first = secret();
    const second = secret();
    vi.mocked(api.post)
      .mockRejectedValueOnce({ response: { status: 422, data: { error: BREACHED, code: 'weak_password', token: replacement } } })
      .mockResolvedValueOnce({ data: { ok: true, sessions_signed_out: true } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, first);

    expect(await screen.findByRole('alert')).toHaveTextContent(BREACHED);
    expect(screen.getByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    // The refused password is cleared so the user picks another one.
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');

    await choose(user, second);

    expect(api.post).toHaveBeenNthCalledWith(1, '/api/auth/password/reset', { token, password: first }, { silentErrors: true });
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/auth/password/reset', { token: replacement, password: second }, { silentErrors: true });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?reset=1'));
  });

  it('keeps the replacement token in memory only: never in the address bar or browser storage', async () => {
    const replacement = secret();
    vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 422, data: { error: BREACHED, code: 'weak_password', token: replacement } } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());
    await screen.findByRole('alert');

    expect(window.location.href).not.toContain(replacement);
    expect(screen.getByTestId('where')).not.toHaveTextContent(replacement);
    const stored = JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }, window.history.state]);
    expect(stored).not.toContain(replacement);
    expect(document.body.innerHTML).not.toContain(replacement);
  });

  it('a breached password that came back without a replacement shows the message and the way to a new link', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 422, data: { error: BREACHED, code: 'weak_password' } } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());

    expect(await screen.findByText(BREACHED)).toBeInTheDocument();
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/forgot-password');
  });

  it('any other failure keeps the form and the same token, and ignores a token it was not meant to get', async () => {
    const stray = secret();
    vi.mocked(api.post)
      .mockRejectedValueOnce({ response: { status: 400, data: { error: "We couldn't update your password. Try again or contact ServWave support.", token: stray } } })
      .mockResolvedValueOnce({ data: { ok: true, sessions_signed_out: true } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);
    const password = secret();

    await choose(user, password);
    expect(await screen.findByRole('alert')).toHaveTextContent("We couldn't update your password.");
    // The form keeps what the user typed, so they can simply try again.
    expect(screen.getByLabelText('New password')).toHaveValue(password);
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenNthCalledWith(2, '/api/auth/password/reset', { token, password }, { silentErrors: true });
  });

  it('a rate-limited attempt shows ServWave copy inline only, and keeps the form', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 429, data: { error: 'Too many requests', retryAfter: 900 } } });
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret());

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a few minutes, then try again.');
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update password' })).toBeInTheDocument();
    // Silent: the app-wide 429 toast would only repeat the inline message (final review item 7).
    expect(api.post).toHaveBeenCalledWith('/api/auth/password/reset', expect.anything(), { silentErrors: true });
  });

  it('checks the length and the match before asking the server', async () => {
    const user = userEvent.setup();
    openLink(`?token=${token}`);

    await choose(user, secret().slice(0, 7));
    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters.');

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Confirm new password'));
    await choose(user, secret(), secret());
    expect(screen.getByRole('alert')).toHaveTextContent('Passwords do not match.');

    expect(api.post).not.toHaveBeenCalled();
  });

  it('never goes anywhere a query parameter names', async () => {
    const user = userEvent.setup();
    openLink(`?token=${token}&next=${encodeURIComponent('https://evil.example')}&redirect=//evil.example`);

    await choose(user, secret());

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/login?reset=1'));
  });
});
