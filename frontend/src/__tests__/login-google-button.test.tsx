import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import LoginPage from '@/pages/LoginPage';
import { useAuthStore } from '@/stores/auth.store';

const loginWithGoogle = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      login: vi.fn(),
      loginWithGoogle,
      user: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    }),
  );
});

describe('LoginPage Google button', () => {
  it('renders the Google button and calls loginWithGoogle on click', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login'] });

    const button = screen.getByRole('button', { name: /google/i });
    fireEvent.click(button);

    expect(loginWithGoogle).toHaveBeenCalledTimes(1);
  });

  it('shows an error from the ?error= query param', () => {
    renderWithProviders(<LoginPage />, { initialEntries: ['/login?error=Not%20authorized'] });
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
  });
});
