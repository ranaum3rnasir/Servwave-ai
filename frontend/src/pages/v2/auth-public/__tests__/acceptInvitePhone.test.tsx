/**
 * Phone capture on the ROUTED accept-invite screen (Spec C slice 3).
 *
 * Imports `@/pages/v2/auth-public/AcceptInvitePage` - what
 * `pages/v2/routes/auth-public.routes.tsx` mounts at /accept-invite. The
 * legacy `@/pages/AcceptInvitePage` is dead and must not be extended.
 *
 * The page has TWO submit paths and every behaviour below is asserted on both,
 * because a phone carried only by the password button leaves every Google
 * invitee uncaptured while looking finished.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import { getInviteInfo, acceptInvite, recordInviteConsent } from '@/lib/api/invite';
import AcceptInvitePage from '@/pages/v2/auth-public/AcceptInvitePage';

vi.mock('@/lib/api/invite', () => ({
  getInviteInfo: vi.fn(),
  acceptInvite: vi.fn(),
  recordInviteConsent: vi.fn(),
}));

const mockGetInviteInfo = vi.mocked(getInviteInfo);
const mockAcceptInvite = vi.mocked(acceptInvite);
const mockRecordInviteConsent = vi.mocked(recordInviteConsent);

const login = vi.fn();
const loginWithGoogle = vi.fn();
const EMAIL = 'invitee@test.com';

/** Render the page for an invite carrying `phone`, and wait for the ready phase. */
async function openInvite(phone: string | null) {
  mockGetInviteInfo.mockResolvedValue({ email: EMAIL, first_name: 'In', phone, phone_ext: null });
  renderWithProviders(<AcceptInvitePage />, { initialEntries: ['/accept-invite?token=tok'] });
  await screen.findByLabelText('Phone number');
}

beforeEach(() => {
  vi.clearAllMocks();
  const state = { login, loginWithGoogle, user: null, isAuthenticated: false, isLoading: false };
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof useAuthStore);
  mockAcceptInvite.mockResolvedValue(undefined);
  mockRecordInviteConsent.mockResolvedValue(undefined);
});

describe('v2 accept-invite - the number the admin already entered', () => {
  it('prefills the phone box, formatted, so a blank submit is never accidental', async () => {
    await openInvite('+15551112222');
    expect(screen.getByLabelText('Phone number')).toHaveValue('(555) 111-2222');
  });

  it('leaves the box empty when the admin supplied no number', async () => {
    await openInvite(null);
    expect(screen.getByLabelText('Phone number')).toHaveValue('');
  });
});

/** Fill the password pair and tick consent - everything acceptance needs but the phone. */
function fillTheRest() {
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'sup3rsecret' } });
  fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'sup3rsecret' } });
  fireEvent.click(screen.getByRole('checkbox'));
}

function typePhone(value: string) {
  fireEvent.change(screen.getByLabelText('Phone number'), { target: { value } });
}

const submitPassword = () =>
  fireEvent.click(screen.getByRole('button', { name: /Set password/i }));
const submitGoogle = () =>
  fireEvent.click(screen.getByRole('button', { name: /Continue with Google/i }));

describe('v2 accept-invite - a number the hire types', () => {
  it('reaches the password path in E.164, not the masked display form', async () => {
    await openInvite(null);
    typePhone('5559998888');
    fillTheRest();
    submitPassword();

    await waitFor(() =>
      expect(mockAcceptInvite).toHaveBeenCalledWith('tok', 'sup3rsecret', true, '+15559998888'),
    );
    // Acceptance still does what it did before: create the login, land in the app.
    await waitFor(() => expect(login).toHaveBeenCalledWith(EMAIL, 'sup3rsecret'));
  });

  it('reaches the Google path in E.164 too', async () => {
    await openInvite(null);
    typePhone('5559998888');
    fillTheRest();
    submitGoogle();

    await waitFor(() =>
      expect(mockRecordInviteConsent).toHaveBeenCalledWith('tok', '+15559998888'),
    );
    await waitFor(() => expect(loginWithGoogle).toHaveBeenCalledWith(EMAIL));
  });
});

describe('v2 accept-invite - a blank box is not an erasure', () => {
  it('submits normally on the password path and sends no number', async () => {
    await openInvite('+15551112222');
    typePhone('');
    fillTheRest();
    submitPassword();

    // null, never '' - the API reads null as "leave the stored number alone",
    // which is what protects the number the admin already entered.
    await waitFor(() =>
      expect(mockAcceptInvite).toHaveBeenCalledWith('tok', 'sup3rsecret', true, null),
    );
  });

  it('submits normally on the Google path and sends no number', async () => {
    await openInvite('+15551112222');
    typePhone('');
    fillTheRest();
    submitGoogle();

    await waitFor(() => expect(mockRecordInviteConsent).toHaveBeenCalledWith('tok', null));
  });

  it('re-sends the untouched prefill unchanged, so nothing is lost by not typing', async () => {
    await openInvite('+15551112222');
    fillTheRest();
    submitPassword();

    await waitFor(() =>
      expect(mockAcceptInvite).toHaveBeenCalledWith('tok', 'sup3rsecret', true, '+15551112222'),
    );
  });
});

describe('v2 accept-invite - an unusable number', () => {
  it('says why and submits nothing on the password path', async () => {
    await openInvite(null);
    typePhone('555');
    fillTheRest();
    submitPassword();

    expect(
      await screen.findByText('Enter a 10-digit US or Canadian phone number'),
    ).toBeInTheDocument();
    expect(mockAcceptInvite).not.toHaveBeenCalled();
    expect(login).not.toHaveBeenCalled();
  });

  it('says why and submits nothing on the Google path', async () => {
    await openInvite(null);
    typePhone('555');
    fillTheRest();
    submitGoogle();

    expect(
      await screen.findByText('Enter a 10-digit US or Canadian phone number'),
    ).toBeInTheDocument();
    expect(mockRecordInviteConsent).not.toHaveBeenCalled();
    expect(loginWithGoogle).not.toHaveBeenCalled();
  });

  // A number stored before normalization existed prefills as itself and cannot
  // be normalized. Gating on it would lock the hire out of their own invite
  // over a field they never touched, so the gate is on what was TYPED.
  it('does not block acceptance when it is the untouched prefill', async () => {
    await openInvite('555-0188');
    expect(screen.getByLabelText('Phone number')).toHaveValue('555-0188');

    fillTheRest();
    submitPassword();

    await waitFor(() =>
      expect(mockAcceptInvite).toHaveBeenCalledWith('tok', 'sup3rsecret', true, null),
    );
    expect(screen.queryByText('Enter a 10-digit US or Canadian phone number')).toBeNull();
  });
});
