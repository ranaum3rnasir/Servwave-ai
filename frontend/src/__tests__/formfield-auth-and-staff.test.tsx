/**
 * FormField adoption - phase 11b/11d, the "auth and staff" batch.
 *
 * Pins the RENDERED CONTRACT of the three converted forms (LoginPage,
 * AcceptInvitePage, StaffFormDialog), at the rigour of
 * components/patterns/__tests__/FormField.test.tsx. Four things are asserted,
 * and each one exists because it could silently regress:
 *
 * 1. THE DEFECT THE CONVERSION CLOSES: the label's `htmlFor` and the
 *    control's `id` are ONE generated fact, not two literals. Before this
 *    batch LoginPage typed `htmlFor="email"` and `id="email"` by hand in two
 *    places; StaffFormDialog typed neither, so five `<Label>`s pointed at
 *    nothing at all. Asserting `label.for === control.id` (rather than
 *    asserting a literal id) is what makes the test survive the useId path
 *    and still catch a drift.
 *
 * 2. BYTE-EXACT CLASS STRINGS, both halves. FormField's own three elements
 *    (Stack root, Label, error Text) are pinned exactly, so a change to any
 *    primitive's default shows up here as a diff rather than as a silent
 *    restyle of the sign-in page. The CONTROL's class is pinned too - the
 *    conversion deliberately did NOT swap the auth pages' hand-styled raw
 *    `<input>` for the `Input` primitive (that is a visible restyle, not a
 *    structural refactor - recorded as a deferral), and this assertion is
 *    what stops that from happening by accident.
 *
 * 3. THE ERROR PATH: `aria-invalid` + `aria-describedby` now point at a real
 *    error node. Neither existed on any of these forms before.
 *
 * 4. THE DEFERRAL IS PINNED, NOT JUST WRITTEN DOWN. AcceptInvitePage's Terms
 *    consent row is a `<label>` that WRAPS its checkbox; FormField renders
 *    label-above-control and was deliberately not given a prop to express
 *    that shape. The test asserts the row is still a wrapping label, so
 *    "someone widened FormField to swallow it" is a red test, not a silent
 *    API accretion.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { renderWithProviders } from './helpers';
import LoginPage from '@/pages/LoginPage';
import AcceptInvitePage from '@/pages/AcceptInvitePage';
import { StaffFormDialog } from '@/components/settings/StaffFormDialog';

// ─── module mocks ────────────────────────────────────────────────────────

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigate,
    useSearchParams: () => [new URLSearchParams('token=abc'), vi.fn()],
  };
});

const getInviteInfo = vi.fn();
vi.mock('@/lib/api/invite', () => ({
  getInviteInfo: (...a: unknown[]) => getInviteInfo(...a),
  acceptInvite: vi.fn(),
  recordInviteConsent: vi.fn(),
}));

vi.mock('@/lib/api/departments', () => ({
  useDepartments: () => ({ data: [{ id: 'd1', name: 'Service' }] }),
}));

vi.mock('@/lib/api/users', () => ({
  useInviteUser: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateUser: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// ─── the exact strings this batch is pinning ─────────────────────────────

/** `<Stack gap={1.5}>` - FormField's root, its only layout decision. */
const FIELD_ROOT_CLASS = 'flex flex-col gap-1.5';

/** `<Label>` with no props: size `sm`, tone `subtle`, weight `bold`. */
const FIELD_LABEL_CLASS =
  'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
  'has-[+input:is(:hover,:focus)]:text-text-primary ' +
  'has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold';

/** `<Text as="p" size="xs" tone="danger">` - FormField's error slot. */
const FIELD_ERROR_CLASS = 'text-xs text-danger-text';

/**
 * The auth pages' own hand-styled input treatment, UNCHANGED by this batch.
 * Compared after collapsing runs of whitespace, because the source authors it
 * as a wrapped JSX string literal and the newline survives into the attribute
 * verbatim - the token sequence is the fact being pinned, not the indentation.
 */
const AUTH_INPUT_CLASS =
  'w-full rounded-lg border border-border px-3 py-2.5 text-sm ' +
  'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

const normalize = (el: Element) => (el.getAttribute('class') ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  vi.clearAllMocks();
  getInviteInfo.mockResolvedValue({ email: 'jane@test.com', first_name: 'Jane' });
});

// ─── LoginPage ───────────────────────────────────────────────────────────

describe('LoginPage - FormField conversion', () => {
  it('wires one id to both the label and the control, for Email and Password', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    for (const name of ['Email', 'Password']) {
      const control = screen.getByLabelText(name);
      expect(screen.getByText(name).getAttribute('for')).toBe(control.id);
      expect(control.id).toBeTruthy();
    }
  });

  it('renders the FormField root, label and control with byte-exact classes', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    const label = screen.getByText('Email');
    const input = screen.getByLabelText('Email');

    expect(label.getAttribute('class')).toBe(FIELD_LABEL_CLASS);
    expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
    // The control is still the page's own raw input, not the Input primitive -
    // see the deferral note in the header.
    expect(input.tagName).toBe('INPUT');
    expect(normalize(input)).toBe(AUTH_INPUT_CLASS);
  });

  it('has no aria-describedby or aria-invalid before a validation error', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });
    const input = screen.getByLabelText('Email');
    expect(input).not.toHaveAttribute('aria-describedby');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('wires aria-invalid and aria-describedby to the rendered error on submit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    const error = await screen.findByText('Enter a valid email');
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'email-error');
    expect(error).toHaveAttribute('id', 'email-error');
    expect(error.tagName).toBe('P');
    expect(error.getAttribute('class')).toBe(FIELD_ERROR_CLASS);

    // Password's own field is wired independently, not to Email's error node.
    expect(screen.getByLabelText('Password')).toHaveAttribute(
      'aria-describedby',
      'password-error',
    );
  });

  it('wires the MFA code step the same way, autoFocus and maxLength preserved', async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue({ mfaRequired: true, challengeId: 'chal_1' });
    const { useAuthStore } = await import('@/stores/auth.store');
    vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
      selector({ login, verifyMfa: vi.fn(), loginWithGoogle: vi.fn(), user: null }),
    );

    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });
    await user.type(screen.getByLabelText('Email'), 'a@b.com');
    await user.type(screen.getByLabelText('Password'), 'pw123456');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    const code = await screen.findByLabelText('Verification code');
    expect(screen.getByText('Verification code').getAttribute('for')).toBe(code.id);
    expect(code).toHaveAttribute('id', 'mfa-code');
    expect(code).toHaveAttribute('maxlength', '6');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  });
});

// ─── AcceptInvitePage ────────────────────────────────────────────────────

describe('AcceptInvitePage - FormField conversion', () => {
  const renderPage = () =>
    render(
      <MemoryRouter>
        <AcceptInvitePage />
      </MemoryRouter>,
    );

  it('wires one id to both the label and the control, for both password fields', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));

    for (const name of ['Password', 'Confirm password']) {
      const control = screen.getByLabelText(name);
      expect(screen.getByText(name).getAttribute('for')).toBe(control.id);
    }
    expect(screen.getByLabelText('Password')).toHaveAttribute('id', 'password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('id', 'confirm');
  });

  it('renders the FormField root, label and control with byte-exact classes', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));

    const label = screen.getByText('Password');
    const input = screen.getByLabelText('Password');
    expect(label.getAttribute('class')).toBe(FIELD_LABEL_CLASS);
    expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
    expect(input.tagName).toBe('INPUT');
    expect(normalize(input)).toBe(AUTH_INPUT_CLASS);
  });

  it('leaves the Terms consent row as a WRAPPING label - the recorded deferral', async () => {
    renderPage();
    await waitFor(() => expect(getInviteInfo).toHaveBeenCalledWith('abc'));

    const checkbox = screen.getByRole('checkbox', {
      name: /agree to the terms of service and privacy policy/i,
    });
    const wrapper = checkbox.closest('label');
    // FormField renders label-ABOVE-control and was deliberately not given a
    // prop for the inline wrapping shape. If this ever becomes null, either
    // the row was converted (needs its own visual sign-off) or FormField grew
    // an API to swallow it (the thing phase 12f forbids).
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveClass('flex', 'items-start', 'gap-2');
  });
});

// ─── StaffFormDialog ─────────────────────────────────────────────────────

describe('StaffFormDialog - FormField conversion', () => {
  const renderDialog = () =>
    renderWithProviders(
      <StaffFormDialog open mode="create" onOpenChange={vi.fn()} />,
    );

  it('wires a generated id to the label and the Input, where five Labels pointed at nothing before', () => {
    renderDialog();

    for (const name of ['First name', 'Last name', 'Email']) {
      const control = screen.getByLabelText(name);
      expect(control.tagName).toBe('INPUT');
      expect(control.id).toBeTruthy();
      expect(screen.getByText(name).getAttribute('for')).toBe(control.id);
    }
  });

  it('wires the Select fields through the render-prop child, id landing on the trigger', () => {
    renderDialog();

    const triggers = screen.getAllByRole('combobox');
    expect(triggers).toHaveLength(2);
    const [role, department] = triggers;
    expect(role!.id).toBeTruthy();
    expect(screen.getByText('Role').getAttribute('for')).toBe(role!.id);
    expect(screen.getByText('Department').getAttribute('for')).toBe(department!.id);
    // Two fields, two distinct generated ids - not one shared useId.
    expect(role!.id).not.toBe(department!.id);
  });

  it('renders the FormField root and label with byte-exact classes', () => {
    renderDialog();
    const label = screen.getByText('First name');
    expect(label.getAttribute('class')).toBe(FIELD_LABEL_CLASS);
    expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });

  it('keeps the Email field disabled in edit mode, prop pass-through unchanged', () => {
    renderWithProviders(
      <StaffFormDialog
        open
        mode="edit"
        onOpenChange={vi.fn()}
        initial={
          {
            id: 'u1',
            first_name: 'Jane',
            last_name: 'Doe',
            email: 'jane@test.com',
            role: 'TECHNICIAN',
            department_id: null,
          } as never
        }
      />,
    );
    expect(screen.getByLabelText('Email')).toBeDisabled();
  });

  it('renders a field error through FormField, with aria-invalid on the control', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole('button', { name: /send invite/i }));

    const error = await screen.findByText('Invalid email');
    expect(error.tagName).toBe('P');
    expect(error.getAttribute('class')).toBe(FIELD_ERROR_CLASS);
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email.getAttribute('aria-describedby')).toBe(error.id);
  });
});
