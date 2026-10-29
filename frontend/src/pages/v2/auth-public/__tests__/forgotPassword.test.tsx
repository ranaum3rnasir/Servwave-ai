/**
 * "Forgot password?" on sign-in and the forgot page (password reset spec §5.1 steps 1-2, slice 04).
 *
 * Seams: what the user sees and can do on the page, and the request it makes (the app's axios
 * instance, mocked in the vitest setup).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useLocation } from 'react-router-dom';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import LoginPage from '@/pages/v2/auth-public/LoginPage';
import ForgotPasswordPage from '@/pages/v2/auth-public/ForgotPasswordPage';

const SIGNED_OUT = { login: vi.fn(), verifyMfa: vi.fn(), loginWithGoogle: vi.fn(), user: null, isAuthenticated: false, isLoading: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
  vi.mocked(api.post).mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Where the router is, so a test can follow a link without a real browser. */
function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderApp(entry: string) {
  return renderWithProviders(
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      </Routes>
      <Where />
    </>,
    { initialEntries: [entry] },
  );
}

const CONFIRMATION = (email: string) =>
  `If an account exists for ${email}, we've sent a link to reset your password. It expires in 1 hour. Check your spam folder if it doesn't arrive.`;

describe('sign-in page', () => {
  it('keeps the selectors sign-in automation depends on', () => {
    renderApp('/login');
    expect(document.querySelector('#email')).toBeTruthy();
    expect(document.querySelector('#password')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign In' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('"Forgot password?" opens the forgot page with the typed email filled in', async () => {
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(screen.getByLabelText('Email'), 'dana+x@example.test');
    await user.click(screen.getByRole('link', { name: 'Forgot password?' }));

    expect(screen.getByTestId('where')).toHaveTextContent('/forgot-password?email=dana%2Bx%40example.test');
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('dana+x@example.test');
  });

  it('"Forgot password?" is reachable from the keyboard, after the password field', async () => {
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(screen.getByLabelText('Password'));
    await user.tab(); // the eye button
    await user.tab();

    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveFocus();
  });

  it('after a reset, says the password was updated', () => {
    renderApp('/login?reset=1');
    expect(screen.getByRole('status')).toHaveTextContent('Your password was updated. Sign in with your new password.');
  });

  it('after a reset that could not sign out other devices, shows only the warning, not the update twice', () => {
    renderApp('/login?reset=1&others=1');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Your password was updated/)).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Your password was updated, but we couldn't sign out your other devices. Contact ServWave support if you think someone else has access.",
    );
  });

  it('the other-devices line needs the reset flag too', () => {
    renderApp('/login?others=1');
    expect(screen.queryByText(/sign out your other devices/)).not.toBeInTheDocument();
  });

  it('shows no notice without the reset flag', () => {
    renderApp('/login');
    expect(screen.queryByText(/Your password was updated/)).not.toBeInTheDocument();
  });
});

describe('forgot page', () => {
  it('has the title, the field, the button and a way back', () => {
    renderApp('/forgot-password');
    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
  });

  it('sends the email to the server and shows the one confirmation', async () => {
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.type(screen.getByLabelText('Email'), 'dana@example.test');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(api.post).toHaveBeenCalledWith('/api/auth/password/forgot', { email: 'dana@example.test' }, { silentErrors: true });
    expect(await screen.findByRole('status')).toHaveTextContent(CONFIRMATION('dana@example.test'));
  });

  it('the confirmation is the same whatever the email, since the server answers the same', async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    for (const email of ['dana@example.test', 'nobody@example.test']) {
      const { unmount } = renderApp('/forgot-password');
      await user.type(screen.getByLabelText('Email'), email);
      await user.click(screen.getByRole('button', { name: 'Send reset link' }));
      seen.push((await screen.findByRole('status')).textContent!.replace(email, '{email}'));
      unmount();
    }
    expect(seen[0]).toBe(seen[1]);
  });

  it('checks the address before asking the server', async () => {
    const user = userEvent.setup();
    renderApp('/forgot-password');

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(screen.getByText('Enter a valid email')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('says so when the request could not be made', async () => {
    vi.mocked(api.post).mockRejectedValue({ response: { status: 429, data: { error: 'Too many requests' } } });
    const user = userEvent.setup();
    renderApp('/forgot-password?email=dana%40example.test');

    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    // ServWave copy, not the limiter's bare "Too many requests"; the request is silent, so the
    // app-wide toast does not repeat it (final review item 7).
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Wait a few minutes, then try again.');
    expect(screen.queryByText('Too many requests')).not.toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/api/auth/password/forgot', expect.anything(), { silentErrors: true });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('"Send again" is offered after 60 seconds and sends the same email again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp('/forgot-password?email=dana%40example.test');

    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(CONFIRMATION('dana@example.test'));
    const again = screen.getByRole('button', { name: 'Send again' });
    expect(again).toBeDisabled();

    act(() => vi.advanceTimersByTime(59_000));
    expect(screen.getByRole('button', { name: 'Send again' })).toBeDisabled();

    act(() => vi.advanceTimersByTime(1_500));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send again' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenLastCalledWith('/api/auth/password/forgot', { email: 'dana@example.test' }, { silentErrors: true });
    expect(screen.getByRole('button', { name: 'Send again' })).toBeDisabled();
  });

  it('a link to this page cannot send the user anywhere else', async () => {
    const user = userEvent.setup();
    renderApp('/forgot-password?email=dana%40example.test&next=https%3A%2F%2Fevil.example&redirect=//evil.example');

    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/login');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));
    await screen.findByRole('status');
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/forgot-password/);
  });
});
