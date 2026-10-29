/**
 * Login & Security for a user who signs in only with Google (password reset spec §4.1 last bullet,
 * §4.3 Google-only case; slice 06).
 *
 * Seam: the page as the user drives it, with the network at the API client. Whether the user has a
 * password comes from the server (GET /api/users/me/password-status), never from the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import SecurityPage from '@/pages/v2/settings/SecurityPage';

const GOOGLE_ONLY_TEXT = 'You sign in with Google. To also sign in with a password, use Set a password by email.';
const VENDOR_WORDS = /supabase|gotrue|resend|render|vercel|identit|provider/i;

let hasPassword: unknown;

function apiError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasPassword = false;
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.includes('mfa/status')) return Promise.resolve({ data: { enrolled: false } });
    if (url.includes('password-status')) return Promise.resolve({ data: { has_password: hasPassword } });
    return Promise.resolve({ data: { mfa_sms_enabled: false } });
  });
  vi.mocked(api.post).mockResolvedValue({ data: { ok: true, email: 'me@test.com' } });
  const state = { user: { email: 'me@test.com' } };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
});

afterEach(() => cleanup());

async function renderPage() {
  const user = userEvent.setup();
  renderWithProviders(<SecurityPage />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return user;
}

/** The password card: the nearest box around its heading. */
function card(): HTMLElement {
  let el: HTMLElement | null = screen.getByRole('heading', { name: 'Change Password' });
  while (el && !within(el).queryByRole('button')) el = el.parentElement;
  return el!;
}

describe('Login & Security for a Google-only user', () => {
  it('shows the message and the button, and no password fields', async () => {
    await renderPage();

    expect(within(card()).getByText((_, el) => el?.tagName === 'P' && el.textContent === GOOGLE_ONLY_TEXT)).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Set a password by email' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Current password/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/New password/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();
  });

  it('asks the server whether there is a password', async () => {
    await renderPage();

    expect(api.get).toHaveBeenCalledWith('/api/users/me/password-status', expect.objectContaining({ silentErrors: true }));
  });

  it('sends the link and says where it went and when it expires', async () => {
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: 'Set a password by email' }));

    // No address in the request: the server sends to the one on file.
    expect(api.post).toHaveBeenCalledWith('/api/users/me/password/email-link', undefined, { silentErrors: true });
    expect(await within(card()).findByRole('status')).toHaveTextContent(
    "We've sent a link to me@test.com. It expires in 1 hour.",
    );
  });

  it.each([
    [
      'the per-email limit',
      apiError(429, {
        error: "We've already sent 3 reset links to this address in the last 15 minutes. Use the newest email, or try again later.",
        code: 'reset_link_limit',
      }),
      "We've already sent 3 reset links to this address in the last 15 minutes. Use the newest email, or try again later.",
    ],
    [
      'a failed send',
      apiError(502, { error: "We couldn't send the email. Try again or contact ServWave support.", code: 'reset_link_not_sent' }),
      "We couldn't send the email. Try again or contact ServWave support.",
    ],
    [
      "the per-user limiter's bare 429",
      apiError(429, { error: 'Too many requests', retryAfter: 900 }),
      "You've asked for too many links. Use the newest email, or try again in 15 minutes.",
    ],
    [
      'a network failure',
      new Error('Network Error'),
      "We couldn't send the email. Try again or contact ServWave support.",
    ],
  ])('says so plainly on %s', async (_label, error, text) => {
    vi.mocked(api.post).mockRejectedValue(error);
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: 'Set a password by email' }));

    expect(await within(card()).findByRole('alert')).toHaveTextContent(text);
  });

  it('disables the button while the link is being sent', async () => {
    let finish!: (v: unknown) => void;
    vi.mocked(api.post).mockReturnValue(new Promise((r) => (finish = r)) as never);
    const user = await renderPage();

    await user.click(screen.getByRole('button', { name: 'Set a password by email' }));

    expect(within(card()).getByRole('button', { name: 'Sending...' })).toBeDisabled();
    await act(async () => finish({ data: { ok: true, email: 'me@test.com' } }));
    expect(within(card()).getByRole('button', { name: 'Set a password by email' })).toBeEnabled();
  });

  it('names no vendor anywhere in the card, whatever happens', async () => {
    const user = await renderPage();
    const before = card().textContent ?? '';
    await user.click(screen.getByRole('button', { name: 'Set a password by email' }));
    await within(card()).findByRole('status');

    expect(before + (card().textContent ?? '')).not.toMatch(VENDOR_WORDS);
  });
});

describe('Login & Security for a user with a password', () => {
  it('shows the change form, not the Google-only message', async () => {
    hasPassword = true;
    await renderPage();

    expect(screen.getByLabelText(/^Current password/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set a password by email' })).not.toBeInTheDocument();
    expect(screen.queryByText(/You sign in with Google/)).not.toBeInTheDocument();
  });

  it.each([
    ['missing', {}],
    ['null', { has_password: null }],
    ['a string', { has_password: 'false' }],
    ['a number', { has_password: 0 }],
  ])('shows the change form when has_password is %s: only a strict false means Google-only', async (_label, body) => {
    vi.mocked(api.get).mockImplementation((url: string) =>
      Promise.resolve({ data: url.includes('password-status') ? body : url.includes('mfa/status') ? { enrolled: false } : { mfa_sms_enabled: false } }),
    );
    await renderPage();

    expect(screen.getByLabelText(/^Current password/)).toBeInTheDocument();
    expect(screen.queryByText(/You sign in with Google/)).not.toBeInTheDocument();
  });

  it('shows the change form when the status cannot be loaded', async () => {
    vi.mocked(api.get).mockImplementation((url: string) =>
      url.includes('password-status')
        ? Promise.reject(new Error('Network Error'))
        : Promise.resolve({ data: url.includes('mfa/status') ? { enrolled: false } : { mfa_sms_enabled: false } }),
    );
    await renderPage();

    expect(screen.getByLabelText(/^Current password/)).toBeInTheDocument();
  });
});

describe('Login & Security while the password status is loading', () => {
  it('shows a neutral placeholder, neither the form nor the Google-only card, until the server answers', async () => {
    let answer!: (v: unknown) => void;
    vi.mocked(api.get).mockImplementation((url: string) =>
      url.includes('password-status')
        ? (new Promise((r) => (answer = r)) as never)
        : Promise.resolve({ data: url.includes('mfa/status') ? { enrolled: false } : { mfa_sms_enabled: false } }),
    );
    await renderPage();

    expect(within(card()).getByTestId('password-card-loading')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Current password/)).not.toBeInTheDocument();
    expect(screen.queryByText(/You sign in with Google/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update password' })).not.toBeInTheDocument();

    await act(async () => answer({ data: { has_password: true } }));

    expect(screen.queryByTestId('password-card-loading')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Current password/)).toBeInTheDocument();
  });
});
