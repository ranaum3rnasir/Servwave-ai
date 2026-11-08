/**
 * Phone capture on the ROUTED My Profile screen (Spec C slice 2).
 *
 * Imports `@/pages/v2/settings/MyProfilePage` - what
 * `pages/v2/routes/settings.routes.tsx` mounts at /settings/profile. The older
 * `my-profile-page.test.tsx` imports `@/pages/settings/MyProfilePage`, a dead
 * v1 fork, and must not be extended: a gate written there passes against a page
 * nobody opens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useUpdateMe, useChangeMyPassword } from '@/lib/api/users';
import MyProfilePage from '@/pages/v2/settings/MyProfilePage';

// The Save button lives in the v2 settings shell, not in the page: capture the
// saver the page registers so a test can drive the same path the button does,
// and read back the `isDirty` the shell disables that button on.
let registered: { save: () => Promise<void> | void; isDirty: boolean } | null = null;
vi.mock('@/pages/v2/settings/settingsBar', () => ({
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void; isDirty: boolean }) => {
      registered = fns;
    },
  }),
}));

vi.mock('@/lib/api/users', () => ({
  useUpdateMe: vi.fn(),
  useChangeMyPassword: vi.fn(),
}));

// Self-fetching (usePunches) - stubbed so these form tests issue no timeclock queries.
vi.mock('@/components/timeclock/MyTimeLog', () => ({
  default: () => null,
  MyTimeLog: () => null,
}));

const mockUseUpdateMe = vi.mocked(useUpdateMe);
const mockUseChangeMyPassword = vi.mocked(useChangeMyPassword);
const mockUseAuthStore = vi.mocked(useAuthStore);

const UPDATED_ROW = {
  id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Tester',
  role: 'TECHNICIAN', is_active: true, has_login: true,
  phone: '+15559998888', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false,
  created_at: '', updated_at: '',
};

let updateMutate: ReturnType<typeof vi.fn>;

// The store object is built ONCE per test, not per selector call: the page
// hydrates on `[user, reset]`, so a fresh identity every render would reset the
// form forever.
function setUser(phone: string | null) {
  const state = {
    user: {
      id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Tester',
      role: 'TECHNICIAN', organization_id: 'o1', phone, phone_ext: '', has_login: true,
    },
    applyUserPatch: vi.fn(),
  };
  mockUseAuthStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector(state),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registered = null;
  updateMutate = vi.fn().mockResolvedValue(UPDATED_ROW);
  mockUseUpdateMe.mockReturnValue({ mutateAsync: updateMutate } as unknown as ReturnType<typeof useUpdateMe>);
  mockUseChangeMyPassword.mockReturnValue({
    mutateAsync: vi.fn(), isPending: false,
  } as unknown as ReturnType<typeof useChangeMyPassword>);
  setUser('+15551112222');
});

/** The phone box is controlled through the mask, so drive it with a change event. */
function typePhone(value: string) {
  fireEvent.change(screen.getByDisplayValue('(555) 111-2222'), { target: { value } });
}

describe('v2 My Profile - a user cannot save themselves an unusable number', () => {
  it('shows the rule and refuses the save, sending nothing', async () => {
    renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('(555) 111-2222');

    typePhone('555');

    expect(await screen.findByText(/10-digit US or Canadian phone number/i)).toBeInTheDocument();
    // The saver refuses with a ValidationError, which is what the shell reads to
    // toast the rule instead of falsely reporting "Settings saved".
    await act(async () => {
      await expect(Promise.resolve(registered!.save())).rejects.toMatchObject({
        name: 'ValidationError',
      });
    });
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('sends a usable number in E.164 form', async () => {
    renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('(555) 111-2222');

    typePhone('5559998888');
    expect(screen.queryByText(/10-digit US or Canadian phone number/i)).toBeNull();
    expect(registered!.isDirty).toBe(true);

    await act(async () => { await registered!.save(); });
    expect(updateMutate).toHaveBeenCalledWith({ phone: '+15559998888' });
  });

  it('renders a stored E.164 number human-readable, so a reopened profile shows what was saved', async () => {
    renderWithProviders(<MyProfilePage />);
    expect(await screen.findByDisplayValue('(555) 111-2222')).toBeInTheDocument();
  });
});

describe('v2 My Profile - a legacy stored number does not block the rest of the form', () => {
  it('saves a name-only edit for a user whose own stored phone is unusable', async () => {
    setUser('555-0188');
    renderWithProviders(<MyProfilePage />);
    const firstName = await screen.findByDisplayValue('Jane');

    fireEvent.change(firstName, { target: { value: 'Janet' } });

    expect(registered!.isDirty).toBe(true);
    await act(async () => { await registered!.save(); });
    // Dirty-only: the untouched legacy number is never re-sent, so it cannot 400
    // a name change the user is entitled to make.
    expect(updateMutate).toHaveBeenCalledWith({ first_name: 'Janet' });
  });

  it('accepts clearing the phone box entirely - the field is optional', async () => {
    renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('(555) 111-2222');

    typePhone('');

    expect(screen.queryByText(/10-digit US or Canadian phone number/i)).toBeNull();
    await act(async () => { await registered!.save(); });
    expect(updateMutate).toHaveBeenCalledWith({ phone: null });
  });
});

describe('v2 My Profile - an unusable phone must not disarm the leave guard', () => {
  it('keeps the reported dirty flag true while refusing the save', async () => {
    renderWithProviders(<MyProfilePage />);
    const firstName = await screen.findByDisplayValue('Jane');

    // A real edit the user would hate to lose...
    fireEvent.change(firstName, { target: { value: 'Janet' } });
    // ...and an unusable number left sitting in the phone box.
    typePhone('555');

    expect(await screen.findByText(/10-digit US or Canadian phone number/i)).toBeInTheDocument();

    // SettingsLayout pushes this same flag into the settings guard store, which
    // arms the unsaved-changes confirm for the topbar user menu, the sidebar,
    // GlobalSearch, browser reload/tab-close and the settings sub-nav. It must
    // stay TRUE, or the name edit above is thrown away with no prompt.
    expect(registered!.isDirty).toBe(true);

    // The unusable number still blocks the write - the two concerns are separate.
    await act(async () => {
      await expect(Promise.resolve(registered!.save())).rejects.toMatchObject({
        name: 'ValidationError',
      });
    });
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('still reports clean when nothing has been edited at all', async () => {
    renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('(555) 111-2222');

    // The guard must not be armed by merely opening the page, or every visit
    // ends in a spurious "discard your changes?" prompt.
    expect(registered!.isDirty).toBe(false);
  });
});
