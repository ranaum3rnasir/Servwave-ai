// Dialer slice 2.2 — /customers/new?phone=<e164> (the dialer's unknown-number
// "Create customer" affordance) seeds the phone field: E.164 country code
// stripped, 10-digit input mask applied. Read once via defaultValues.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import CustomerFormPage from '@/pages/CustomerFormPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('CustomerFormPage — ?phone= create-prefill (dialer slice 2.2)', () => {
  it('seeds the phone field from /customers/new?phone=<e164>', async () => {
    renderWithProviders(<CustomerFormPage />, {
      initialEntries: ['/customers/new?phone=%2B15555550199'],
    });

    await waitFor(() =>
      expect(screen.getByDisplayValue('(555) 555-0199')).toBeInTheDocument(),
    );
  });

  it('leaves the phone field empty without the param', async () => {
    renderWithProviders(<CustomerFormPage />, {
      initialEntries: ['/customers/new'],
    });

    const phone = (await screen.findByPlaceholderText('(555) 123-4567')) as HTMLInputElement;
    expect(phone.value).toBe('');
  });
});
