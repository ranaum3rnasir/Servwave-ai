import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import LocationsPage from '@/pages/settings/LocationsPage';

const mockApi = vi.mocked(api);

const LOCATION = {
  id: 'a0000000-0000-0000-0000-0000000000aa',
  organization_id: '00000000-0000-0000-0000-000000000001',
  name: 'Main Branch',
  code: 'MAIN',
  address_line1: '1 Main St',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  postal_code: null,
  country: null,
  timezone: 'America/Chicago',
  phone: null,
  manager_id: null,
  manager: null,
  _count: { members: 0 },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const USERS = [
  { id: 'u1', first_name: 'Pat', last_name: 'Lee', role: 'DISPATCHER', is_active: true, has_login: true, department: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/locations') return Promise.resolve({ data: [LOCATION] });
    if (url === '/api/users') return Promise.resolve({ data: { users: USERS } });
    return Promise.resolve({ data: [] });
  });
});

describe('LocationsPage — edit payload (#107)', () => {
  it('PATCHes only editable fields, dropping echoed read-only keys and the removed code/manager', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockResolvedValue({ data: { ...LOCATION, name: 'Renamed' } });

    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Branch');

    // Open the edit card for the existing row.
    await user.click(screen.getByText('Main Branch'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const [url, body] = mockApi.patch.mock.calls[0];
    expect(url).toBe(`/api/locations/${LOCATION.id}`);
    expect(body).toMatchObject({ name: 'Main Branch' });
    // #511 regression: opening Edit on a NULL-phone location and saving an unrelated
    // field must not silently coerce Location.phone from NULL to ''.
    expect(body.phone).toBeNull();
    // code + manager were removed from the screen; server-echoed / relational keys
    // must never be sent back either.
    for (const k of ['code', 'manager_id', 'created_at', 'updated_at', 'organization_id', 'manager', '_count', 'id']) {
      expect(body).not.toHaveProperty(k);
    }
  });

  it('renders per-field validation details, not just "Validation failed"', async () => {
    const user = userEvent.setup();
    mockApi.patch.mockRejectedValue({
      response: { data: { error: 'Validation failed', details: [{ field: 'code', message: 'Required' }] } },
    });

    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Branch');
    await user.click(screen.getByText('Main Branch'));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/code:/)).toBeInTheDocument();
  });
});
