import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import V1CustomerFormPage from '@/pages/CustomerFormPage';
import V2LoginPage from '@/pages/v2/auth-public/LoginPage';
import V1LoginPage from '@/pages/LoginPage';

/**
 * Mobile slice F23a (follow-up to slice 23). The same trap as the create-lead and
 * create-job forms (email-form-novalidate.test.tsx), on the other forms that carry an
 * email field: the customer form and the sign-in form. Their Email is `type="email"`
 * inside a <form> without `noValidate`, so the browser checks it first, shows its own
 * popup and never fires onSubmit: the app's inline message never renders. Only the v2
 * pages are routed; the v1 twins are covered so a revival does not bring the trap back.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);
const login = vi.fn();
/** The browser fires `invalid` on a field exactly when it would show its own popup. */
function watchBrowserPopup(field: HTMLInputElement): () => boolean {
  let fired = false;
  field.addEventListener('invalid', () => { fired = true; });
  return () => fired;
}

const SIGNED_OUT = { login, verifyMfa: vi.fn(), loginWithGoogle: vi.fn(), user: null, isAuthenticated: false, isLoading: false };

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
  vi.mocked(useAuthStore).mockImplementation(((selector?: (s: unknown) => unknown) =>
    selector ? selector(SIGNED_OUT) : SIGNED_OUT) as unknown as typeof useAuthStore);
});

function renderCustomerForm(Page: () => React.ReactElement | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/customers/new']}>
        <Routes>
          <Route path="/customers/new" element={<Page />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe.each([
  { name: 'v2 customer form', Page: CustomerFormPage },
  { name: 'v1 customer form', Page: V1CustomerFormPage },
])('$name: an invalid email shows the app message, not the browser popup', ({ Page }) => {
  it('submitting "abc" renders the inline message and sends nothing', async () => {
    const user = userEvent.setup();
    const { container } = renderCustomerForm(Page);
    await user.type(await screen.findByPlaceholderText('Jane'), 'Zzqa');
    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.type).toBe('email');
    expect(email.form!.noValidate).toBe(true);
    const browserPopup = watchBrowserPopup(email);
    await user.type(email, 'abc');
    await user.click(screen.getByTestId('customer-form-submit'));
    expect(browserPopup()).toBe(false);
    await waitFor(() => expect(screen.getByText('Enter a valid email address')).toBeInTheDocument());
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe.each([
  { name: 'v2 sign-in', Page: V2LoginPage },
  { name: 'v1 sign-in', Page: V1LoginPage },
])('$name: an invalid email shows the app message, not the browser popup', ({ Page }) => {
  it('submitting "abc" renders the inline message and never signs in', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Page />, { initialEntries: ['/login'] });
    const email = document.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.type).toBe('email');
    expect(email.form!.noValidate).toBe(true);
    const browserPopup = watchBrowserPopup(email);
    await user.type(email, 'abc');
    await user.type(document.querySelector<HTMLInputElement>('input[name="password"]')!, 'x');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(browserPopup()).toBe(false);
    await waitFor(() => expect(screen.getByText('Enter a valid email')).toBeInTheDocument());
    expect(login).not.toHaveBeenCalled();
  });
});
