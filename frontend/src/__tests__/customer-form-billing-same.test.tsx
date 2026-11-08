import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

// #437 — the "Same as service" restore control in the Billing Address panel
// must be a full-size, clearly visible shared Button (outline/sm → h-9 + border),
// not the previous tiny text-xs muted corner button.

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

describe('CustomerFormPage — "Same as service" restore control (#437)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/organization') {
        return Promise.resolve({ data: {} });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the restore control as a full-size outline button, not tiny corner text', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/new'] });

    // Reveal the billing box.
    fireEvent.click(await screen.findByRole('button', { name: /use a different billing address/i }));

    const restore = await screen.findByRole('button', { name: /same as service address/i });
    // Shared Button (variant=outline, size=sm) → h-9 + border, and NOT the old text-xs.
    expect(restore.className).toContain('h-9');
    expect(restore.className).toContain('border');
    expect(restore.className).not.toContain('text-xs');
    // Non-destructive: no danger-red hover.
    expect(restore.className).not.toContain('hover:text-danger');
  });

  it('clicking the restore button collapses billing back to "same as service"', async () => {
    renderWithProviders(<CustomerFormPage />, { initialEntries: ['/customers/new'] });

    fireEvent.click(await screen.findByRole('button', { name: /use a different billing address/i }));
    // Expanded: two "City" inputs (service + billing).
    expect(screen.getAllByPlaceholderText('City')).toHaveLength(2);

    fireEvent.click(await screen.findByRole('button', { name: /same as service address/i }));

    await waitFor(() => {
      expect(
        screen.getByText('Billing address is the same as the service address'),
      ).toBeInTheDocument();
    });
    // Collapsed: billing City input is gone (only the service one remains).
    expect(screen.getAllByPlaceholderText('City')).toHaveLength(1);
  });
});
