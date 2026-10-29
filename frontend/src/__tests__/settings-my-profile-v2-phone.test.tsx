/**
 * Phone capture on the ROUTED My Profile screen (Spec C slice 2).
 *
 * Imports `@/pages/v2/settings/MyProfilePage` - what
 * `pages/v2/routes/settings.routes.tsx` mounts at /settings/profile.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { screen, act, fireEvent, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './helpers';
import { useAuthStore } from '@/stores/auth.store';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { useUpdateMe } from '@/lib/api/users';
import MyProfilePage from '@/pages/v2/settings/MyProfilePage';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { useSettingsBar } from '@/pages/v2/settings/settingsBar';
import type { SettingsSaver } from '@/lib/settings/types';

// The Save button lives in the v2 settings shell, not in the page: capture the
// saver the page registers so a test can drive the same path the button does,
// and read back the flags the shell derives that button from. Typed as the real
// contract, so a spec asserting on a field the contract does not have will not
// compile.
let registered: SettingsSaver | null = null;

// A SPY, not a stand-in: it records what the page registers and then hands it
// straight to the real context. That is what lets the specs below mount the
// genuine v2 SettingsLayout - and assert on its real Save button - without
// losing the direct handle on the saver the page-only specs drive.
vi.mock('@/pages/v2/settings/settingsBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/v2/settings/settingsBar')>();
  return {
    ...actual,
    useSettingsBar: () => {
      const real = actual.useSettingsBar();
      return {
        registerSaver: (fns: SettingsSaver) => {
          registered = fns;
          real.registerSaver(fns);
        },
      };
    },
  };
});

vi.mock('@/lib/api/users', () => ({
  useUpdateMe: vi.fn(),
}));

// Self-fetching (usePunches) - stubbed so these form tests issue no timeclock queries.
vi.mock('@/components/timeclock/MyTimeLog', () => ({
  default: () => null,
  MyTimeLog: () => null,
}));

const mockUseUpdateMe = vi.mocked(useUpdateMe);
const mockUseAuthStore = vi.mocked(useAuthStore);

const UPDATED_ROW = {
  id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Tester',
  role: 'TECHNICIAN', is_active: true, has_login: true,
  phone: '+15559998888', phone_ext: null, department_id: null, department: null,
  enforce_clock_in_location: false, can_approve_clock_overrides: false,
  created_at: '', updated_at: '',
};

let updateMutate: ReturnType<typeof vi.fn>;

// The store object is built ONCE per test, not per selector call: a fresh
// object on every render would look like an endless stream of /api/auth/me
// revalidations.
//
// `overrides` is how the refetch specs below hand the page a NEW object - the
// same user with identical contents (the poll), the same user with changed
// contents (a profile edited elsewhere), or a different `id` entirely (the
// session became somebody else).
function setUser(phone: string | null, overrides: Record<string, unknown> = {}) {
  const state = {
    user: {
      id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Tester',
      role: 'TECHNICIAN', organization_id: 'o1', phone, phone_ext: '', has_login: true,
      ...overrides,
    },
    applyUserPatch: vi.fn(),
  };
  mockUseAuthStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector(state),
  );
  return state;
}

/** No signed-in user yet - the cold-load state, before /api/auth/me answers. */
function setNoUser() {
  const state = { user: null, applyUserPatch: vi.fn() };
  mockUseAuthStore.mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector(state),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registered = null;
  // The shell specs below mount the real SettingsLayout, which publishes into
  // this shared store; a leftover `true` would make the guard assertions pass
  // for the wrong reason.
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  updateMutate = vi.fn().mockResolvedValue(UPDATED_ROW);
  mockUseUpdateMe.mockReturnValue({ mutateAsync: updateMutate } as unknown as ReturnType<typeof useUpdateMe>);
  setUser('+15551112222');
});

/** The phone box is controlled through the mask, so drive it with a change event. */
function typePhone(value: string) {
  fireEvent.change(screen.getByDisplayValue('(555) 111-2222'), { target: { value } });
}

/**
 * The phone box by its input TYPE - the only tel input on the page, and unlike
 * its display value it survives being typed into more than once.
 */
function retypePhone(value: string) {
  fireEvent.change(document.querySelector('input[type="tel"]') as HTMLInputElement, {
    target: { value },
  });
}

// A FACTORY, not a shared element: React bails out of re-rendering a subtree
// whose element object is referentially identical, so handing `rerender` the
// same tree twice would simulate nothing at all.
const shellTree = () => (
  <Routes>
    <Route path="/settings" element={<SettingsLayout />}>
      <Route path="profile" element={<MyProfilePage />} />
    </Route>
  </Routes>
);

/**
 * The page inside the REAL v2 settings shell, mounted on its real route.
 *
 * The defect this file guards is a disagreement between the page and the shell,
 * so the shell has to be the real one: a hand-rolled stand-in would just restate
 * whichever rule the test author had in mind. No AbilityProvider is passed, so
 * `useAppAbility` resolves to the deny-everything default and only the
 * `always: true` My Profile row is listed - the save bar is unaffected.
 */
function renderInShell() {
  return renderWithProviders(shellTree(), { initialEntries: ['/settings/profile'] });
}

/** A form box by its registered `name`, which survives the value changing. */
const box = (name: string) =>
  (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value;

const saveButton = () => screen.getByRole('button', { name: 'Save Changes' });

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

  it('refreshes the signed-in user in the store from the saved row', async () => {
    const state = setUser('+15551112222');
    renderWithProviders(<MyProfilePage />);
    await screen.findByDisplayValue('(555) 111-2222');

    typePhone('5559998888');
    await act(async () => { await registered!.save(); });

    expect(state.applyUserPatch).toHaveBeenCalledTimes(1);
    expect(state.applyUserPatch).toHaveBeenCalledWith({
      first_name: UPDATED_ROW.first_name,
      last_name: UPDATED_ROW.last_name,
      phone: UPDATED_ROW.phone,
      phone_ext: UPDATED_ROW.phone_ext,
      has_login: UPDATED_ROW.has_login,
    });
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

  // S3-07. Everything above stays true, and the Save button goes dead as well.
  // Before `canSave` the shell derived the button from `isDirty` alone, so the
  // only way to grey it out was to lie about being dirty - which is exactly what
  // disarmed the guard. The two are now separate signals; pin BOTH.
  it('greys the shell Save button while keeping the guard armed and the save refusing', async () => {
    renderInShell();
    const firstName = await screen.findByDisplayValue('Jane');

    // A real edit the user would hate to lose...
    fireEvent.change(firstName, { target: { value: 'Janet' } });
    // ...and an unusable number left sitting in the phone box.
    retypePhone('12345');

    expect(await screen.findByText(/10-digit US or Canadian phone number/i)).toBeInTheDocument();

    // 1. The button the QA report found live at +200/+800/+1600ms.
    await waitFor(() => expect(saveButton()).toBeDisabled());
    // 2. Discard is NOT gated on the same thing - the user must always be able
    //    to back out of a form they cannot save.
    expect(screen.getByRole('button', { name: 'Discard' })).toBeEnabled();
    // 3. The guard is still armed, at the store every exit path actually reads.
    expect(registered!.isDirty).toBe(true);
    expect(useSettingsGuard.getState().isDirty).toBe(true);
    // 4. And the saver itself still refuses, so a caller that bypasses the
    //    button is told why rather than silently writing.
    await act(async () => {
      await expect(Promise.resolve(registered!.save())).rejects.toMatchObject({
        name: 'ValidationError',
      });
    });
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('re-enables Save once the bad number is cleared', async () => {
    renderInShell();
    await screen.findByDisplayValue('(555) 111-2222');

    retypePhone('12345');
    await waitFor(() => expect(saveButton()).toBeDisabled());

    // Empty is legal - the field is optional - so the bar must come back to life
    // rather than stranding the user on a value they have already deleted.
    retypePhone('');
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByText(/10-digit US or Canadian phone number/i)).toBeNull();
  });

  it('re-enables Save once the number is completed', async () => {
    renderInShell();
    await screen.findByDisplayValue('(555) 111-2222');

    retypePhone('12345');
    await waitFor(() => expect(saveButton()).toBeDisabled());

    retypePhone('5559998888');
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });
});

/**
 * The other ~23 registerSaver call sites do not pass `canSave` and are not going
 * to. The field is optional and absent must mean SAVEABLE, or this fix silently
 * greys out the Save button on every other settings page in the app.
 */
describe('v2 settings shell - a saver that omits canSave is still saveable', () => {
  function PlainSaverPage() {
    const { registerSaver } = useSettingsBar();
    useEffect(() => {
      // Exactly the three-part object every other settings page registers.
      registerSaver({ save: () => {}, discard: () => {}, isDirty: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>child</div>;
  }

  it('leaves Save enabled for a dirty saver with no canSave field', async () => {
    renderWithProviders(
      <Routes>
        <Route path="/settings" element={<SettingsLayout />}>
          <Route path="company" element={<PlainSaverPage />} />
        </Route>
      </Routes>,
      { initialEntries: ['/settings/company'] },
    );
    await screen.findByText('child');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled());
    expect(registered!.canSave).toBeUndefined();
  });
});


/**
 * #1919. `/api/auth/me` revalidates unattended - measured on staging at +47.0s
 * into a window with no interaction at all - and the store answers it with
 * `set({ user: data.user })`. Zustand does no structural sharing, so that is a
 * brand new object every single time. A hydration effect keyed on the OBJECT
 * therefore re-ran mid-edit and `reset()` put the server's values back: typed
 * `SystemZZ` was `System` again 120ms after the request landed.
 *
 * The lost keystrokes are only half of it. `reset()` also drops `isDirty` to
 * false, and SettingsLayout publishes that flag into the settings guard store,
 * so the unsaved-changes prompt went quiet too - the user could walk away from
 * edits they still believed were pending and never be asked. That is the loss
 * d0a1995df separated `canSave` from `isDirty` to prevent, arriving through a
 * different door: the guard is not wrong, it has been lied to. So every spec
 * here pins `useSettingsGuard.getState().isDirty`, not just the input value.
 */
describe('v2 My Profile - a background auth refetch must not discard an edit', () => {
  it('keeps the typed value, the dirty flag and the armed leave guard when the SAME user re-arrives', async () => {
    const { rerender } = renderInShell();
    const firstName = await screen.findByDisplayValue('Jane');

    fireEvent.change(firstName, { target: { value: 'SystemZZ' } });
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    // The poll lands: a NEW object, identical contents, same id.
    setUser('+15551112222');
    await act(async () => { rerender(shellTree()); });

    expect(box('first_name')).toBe('SystemZZ');
    expect(registered!.isDirty).toBe(true);
    // The assertion that ties this back to #1917 - the store every exit path
    // actually reads. Without it the spec would pass on a page that kept the
    // text on screen while telling the shell it had nothing to lose.
    expect(useSettingsGuard.getState().isDirty).toBe(true);
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('keeps the edit even when the refetch brings CHANGED values for the same user', async () => {
    const { rerender } = renderInShell();
    const firstName = await screen.findByDisplayValue('Jane');

    fireEvent.change(firstName, { target: { value: 'SystemZZ' } });
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    // An admin edited this user's phone in another session. Still the same
    // person, still an edit in progress: the server does not get to win.
    setUser('+15557776666');
    await act(async () => { rerender(shellTree()); });

    expect(box('first_name')).toBe('SystemZZ');
    expect(useSettingsGuard.getState().isDirty).toBe(true);
  });

  it('DOES re-hydrate when the session becomes a different user', async () => {
    const { rerender } = renderInShell();
    const firstName = await screen.findByDisplayValue('Jane');

    fireEvent.change(firstName, { target: { value: 'SystemZZ' } });
    await waitFor(() => expect(useSettingsGuard.getState().isDirty).toBe(true));

    // A genuine identity change - checkAuth() treats this as real enough to
    // clear the entire query cache. This form must not be the one surface left
    // showing the previous account, so the dirty guard has to yield here.
    setUser('+15553334444', { id: 'u2', first_name: 'Morgan', last_name: 'Other' });
    await act(async () => { rerender(shellTree()); });

    await waitFor(() => expect(box('first_name')).toBe('Morgan'));
    expect(registered!.isDirty).toBe(false);
    expect(useSettingsGuard.getState().isDirty).toBe(false);
  });

  it('still refreshes a form nobody has touched', async () => {
    const { rerender } = renderInShell();
    await screen.findByDisplayValue('Jane');

    // Pristine: hydrating is what the effect is FOR, and gating it on identity
    // alone would freeze this page against a profile edited elsewhere.
    setUser('+15551112222', { first_name: 'Janet' });
    await act(async () => { rerender(shellTree()); });

    await waitFor(() => expect(box('first_name')).toBe('Janet'));
    expect(useSettingsGuard.getState().isDirty).toBe(false);
  });

  it('hydrates on first mount, when the user arrives after the page does', async () => {
    setNoUser();
    const { rerender } = renderInShell();
    await waitFor(() => expect(box('first_name')).toBe(''));

    // The cold-load order: the shell renders, then /api/auth/me answers.
    setUser('+15551112222');
    await act(async () => { rerender(shellTree()); });

    await waitFor(() => expect(box('first_name')).toBe('Jane'));
    // The masked phone box is controlled, not registered, so it has no `name` -
    // assert it through its displayed value.
    expect(screen.getByDisplayValue('(555) 111-2222')).toBeInTheDocument();
  });
});
