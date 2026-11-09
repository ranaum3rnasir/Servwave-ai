/**
 * Login & Security > Change Password (password reset spec §4.1/§4.3, slice 02).
 *
 * Seam: the page as the user drives it, with the app's real toaster mounted, and the network at
 * the API client. Typed values are generated per run, never literals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast as sonnerToast } from 'sonner';

import api from '@/lib/axios';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { Toaster } from '@/ui-kit/components/ui/sonner';
import SecurityPage from '@/pages/v2/settings/SecurityPage';

const UPDATED = "Password updated. You've been signed out on your other devices.";
const BREACHED = "This password has appeared in a known data breach, so it isn't safe to use. Choose a different one.";
const typed = () => `t-${Math.random().toString(36).slice(2, 14)}`;

const browserSignIn = vi.fn();
const logout = vi.fn();
const browserUpdateUser = vi.fn();
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

function apiError(status: number, data: unknown) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

beforeEach(() => {
  vi.clearAllMocks();
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  Object.assign(supabase.auth, { signInWithPassword: browserSignIn, updateUser: browserUpdateUser });
  vi.mocked(api.get).mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes('mfa/status') ? { enrolled: false } : { mfa_sms_enabled: false } }),
  );
  vi.mocked(api.post).mockResolvedValue({ data: { message: 'Password updated', other_sessions_signed_out: true } });
  logout.mockResolvedValue(undefined);
  const state = { user: { email: 'me@test.com' }, logout };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
});

afterEach(() => {
  vi.useRealTimers();
  process.off('unhandledRejection', onRejection);
  act(() => {
    sonnerToast.dismiss();
  });
  cleanup();
});

/** A short real tick (at most 100 ms: docs/ci.md); longer waits step a fake clock. */
async function advance(ms: number) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function renderPage() {
  const user = userEvent.setup();
  renderWithProviders(
    <>
      <SecurityPage />
      <Toaster />
    </>,
  );
  return user;
}

async function fill(user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm = next) {
  // The form replaces a placeholder once the password status has loaded.
  await user.type(await screen.findByLabelText(/^Current password/), current);
  await user.type(screen.getByLabelText(/^New password/), next);
  await user.type(screen.getByLabelText(/^Confirm new password/), confirm);
  await user.click(screen.getByRole('button', { name: 'Update password' }));
  await advance(50);
}

/** The Change Password card: the nearest box around its heading that also holds its button. */
function card(): HTMLElement {
  let el: HTMLElement | null = screen.getByRole('heading', { name: 'Change Password' });
  while (el && !within(el).queryByRole('button', { name: /Update password|Updating/ })) el = el.parentElement;
  return el!;
}
const toastList = () => document.querySelector('[data-sonner-toaster]') as HTMLElement | null;

describe('Change Password card', () => {
  it('changes the password through the server, never the browser auth client', async () => {
    const user = renderPage();
    const current = typed();
    const next = typed();

    await fill(user, current, next);

    expect(api.post).toHaveBeenCalledWith('/api/users/me/password', { current_password: current, password: next });
    expect(browserSignIn).not.toHaveBeenCalled();
    expect(browserUpdateUser).not.toHaveBeenCalled();
  });

  it('confirms inline and as a toast, and both are still on screen 5 seconds later', async () => {
    // Fake clock (real time still flows for the typing library): the toast's own timer is stepped over, not slept through.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = renderPage();

    await fill(user, typed(), typed());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    expect(within(card()).getByRole('status')).toHaveTextContent(UPDATED);
    expect(within(toastList()!).getByText(UPDATED)).toBeInTheDocument();
  });

  it('when the other devices could not be signed out, it says so instead of claiming they were', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { message: 'Password updated', other_sessions_signed_out: false } });
    const user = renderPage();

    await fill(user, typed(), typed());
    await advance(100);

    const truthful = "Password updated. We couldn't sign out your other devices. Sign out everywhere to end every session.";
    const notice = within(card()).getByRole('status');
    expect(notice).toHaveTextContent(truthful);
    // A warning, not a success (review O2).
    expect(notice.className).toMatch(/amber/);
    expect(notice.className).not.toMatch(/green/);
    expect(within(toastList()!).getByText(truthful)).toBeInTheDocument();
    expect(toastList()!.querySelector('[data-sonner-toast][data-type="warning"]')).not.toBeNull();
    expect(screen.queryByText(UPDATED)).toBeNull();
  });

  it('"Sign out everywhere" runs the normal sign-out, which ends every session', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { message: 'Password updated', other_sessions_signed_out: false } });
    const user = renderPage();

    await fill(user, typed(), typed());
    await user.click(within(card()).getByRole('button', { name: 'Sign out everywhere' }));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  describe('which device stays signed in (decision §9.2)', () => {
    const originalLocation = window.location;
    const replace = vi.fn();

    beforeEach(() => {
      replace.mockReset();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...originalLocation, pathname: '/settings/security', replace },
      });
    });

    afterEach(() => {
      Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
    });

    it('stays on the page, signed in, when only the other devices were signed out', async () => {
      vi.mocked(api.post).mockResolvedValue({
        data: { message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: false },
      });
      const user = renderPage();

      await fill(user, typed(), typed());

      expect(within(card()).getByRole('status')).toHaveTextContent(UPDATED);
      expect(supabase.auth.signOut).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
    });

    it('when the change ended this device\'s session too, it drops it and opens sign-in with the "password updated" notice', async () => {
      vi.mocked(api.post).mockResolvedValue({
        data: { message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: true },
      });
      vi.mocked(supabase.auth.signOut).mockResolvedValue({ error: null });
      const user = renderPage();

      await fill(user, typed(), typed());

      // Only this browser's copy of the (already ended) session; never every device again.
      expect(supabase.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
      expect(replace).toHaveBeenCalledWith('/login?reset=1');
      // Not "you stay signed in here" copy: the page is leaving.
      expect(screen.queryByText(UPDATED)).toBeNull();
      expect(rejections).toEqual([]);
    });

    it('still opens sign-in when dropping the ended session fails', async () => {
      vi.mocked(api.post).mockResolvedValue({
        data: { message: 'Password updated', other_sessions_signed_out: true, this_device_signed_out: true },
      });
      vi.mocked(supabase.auth.signOut).mockRejectedValue(new Error('offline'));
      const user = renderPage();

      await fill(user, typed(), typed());

      expect(replace).toHaveBeenCalledWith('/login?reset=1');
      expect(rejections).toEqual([]);
    });
  });

  it('offers no sign-out button when the other devices were signed out', async () => {
    const user = renderPage();

    await fill(user, typed(), typed());

    expect(within(card()).getByRole('status')).toHaveTextContent(UPDATED);
    expect(within(card()).getByRole('status').className).toMatch(/green/);
    expect(screen.queryByRole('button', { name: 'Sign out everywhere' })).toBeNull();
  });

  it('clears the fields after a successful change', async () => {
    const user = renderPage();

    await fill(user, typed(), typed());

    for (const label of [/^Current password/, /^New password/, /^Confirm new password/]) {
      expect(screen.getByLabelText(label)).toHaveValue('');
    }
  });

  it('a wrong current password says so inline, with no toast and no unhandled rejection', async () => {
    vi.mocked(api.post).mockRejectedValue(apiError(400, { error: 'Current password is incorrect.', code: 'current_password_incorrect' }));
    const user = renderPage();

    await fill(user, typed(), typed());
    await advance(100);

    expect(within(card()).getByRole('alert')).toHaveTextContent('Current password is incorrect.');
    expect(toastList()?.querySelector('[data-sonner-toast]') ?? null).toBeNull();
    expect(rejections).toEqual([]);
    expect(screen.getByLabelText(/^New password/)).not.toHaveValue('');
  });

  it('a breached new password shows the ServWave wording inline', async () => {
    vi.mocked(api.post).mockRejectedValue(apiError(422, { error: BREACHED, code: 'weak_password' }));
    const user = renderPage();

    await fill(user, typed(), typed());

    expect(within(card()).getByRole('alert')).toHaveTextContent(BREACHED);
  });

  it('a new password equal to the current one is refused before anything is sent', async () => {
    const user = renderPage();
    const same = typed();

    await fill(user, same, same);

    expect(within(card()).getByRole('alert')).toHaveTextContent("Choose a password you haven't used here.");
    expect(api.post).not.toHaveBeenCalled();
  });

  it('a failure with no message from the server shows ServWave copy, not the network error text', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('Network Error'));
    const user = renderPage();

    await fill(user, typed(), typed());

    expect(within(card()).getByRole('alert')).toHaveTextContent(
      "We couldn't update your password. Try again or contact ServWave support.",
    );
  });
});
