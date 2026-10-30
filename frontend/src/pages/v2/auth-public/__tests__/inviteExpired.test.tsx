/**
 * A used, replaced or cancelled invite link (security finding H2, ticket 23): the server answers "expired" and the routed
 * accept-invite screen says so plainly, with a way to ask for a new one and no vendor name anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { getInviteInfo } from '@/lib/api/invite';
import AcceptInvitePage from '@/pages/v2/auth-public/AcceptInvitePage';

vi.mock('@/lib/api/invite', () => ({
  getInviteInfo: vi.fn(),
  acceptInvite: vi.fn(),
  recordInviteConsent: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  const state = { login: vi.fn(), loginWithGoogle: vi.fn(), user: null, isAuthenticated: false, isLoading: false };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
});

describe('v2 accept-invite - a link that has expired', () => {
  it('says "This link has expired", points at the admin for a new invite, and offers no form', async () => {
    vi.mocked(getInviteInfo).mockRejectedValue({
      response: { status: 400, data: { error: 'This invitation link has expired.', code: 'invite_expired' } },
    });
    renderWithProviders(<AcceptInvitePage />, { initialEntries: ['/accept-invite?token=used-once'] });

    expect(await screen.findByText('This link has expired')).toBeInTheDocument();
    expect(screen.getByText('Ask your admin to send you a new invite.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go to sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/supabase|render|ctm|calltracking|stripe/i);
  });

  // A network drop or a server error says nothing about the link, so the page must not call it expired.
  it.each([
    ['a network failure', new Error('Network Error')],
    ['a server error', { response: { status: 500, data: { error: 'Something went wrong' } } }],
    ['a refusal that is not an expired link', { response: { status: 400, data: { error: 'Bad request' } } }],
  ])('after %s it says it could not load, offers Try again, and does not claim the link expired', async (_label, failure) => {
    vi.mocked(getInviteInfo).mockRejectedValueOnce(failure);
    renderWithProviders(<AcceptInvitePage />, { initialEntries: ['/accept-invite?token=fine'] });

    expect(await screen.findByText("We couldn't load this invitation. Please try again.")).toBeInTheDocument();
    expect(screen.queryByText('This link has expired')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/supabase|render|ctm|calltracking|stripe/i);

    // Try again asks the server again, and a good answer opens the invitation.
    vi.mocked(getInviteInfo).mockResolvedValueOnce({ email: 'in@test.com', first_name: 'In', phone: null, phone_ext: null });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(getInviteInfo).toHaveBeenCalledTimes(2);
  });
});
