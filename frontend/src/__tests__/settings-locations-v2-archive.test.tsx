/**
 * Settings > Locations — archive, the way back, and the delete that survives them (slice 2).
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D9)
 * Slice: md_files/issues/scheduling/02-archive-a-location-instead-of-deleting-it.md
 *
 * Imports `@/pages/v2/settings/LocationsPage` - what `pages/v2/routes/settings.routes.tsx` mounts
 * at /settings/locations. The older `settings-locations.test.tsx` drives `@/pages/settings/
 * LocationsPage`, which nothing routes any more, so a gate written there would pass against a
 * screen no admin opens.
 *
 * The failure modes this pins are all "the admin can no longer do the thing":
 *
 *   - hiding archived rows would put the yard they closed last winter behind the only button that
 *     can bring it back;
 *   - offering Archive on a row that is already archived leaves no way to reopen a branch;
 *   - losing Delete makes a typo permanent, which is a worse deal than the problem archiving
 *     solves;
 *   - a 409 that does not mention archiving is the dead end this whole slice exists to remove.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import LocationsPage from '@/pages/v2/settings/LocationsPage';

const mockApi = vi.mocked(api);

const SHOWROOM = {
  id: 'a0000000-0000-0000-0000-0000000000a1',
  organization_id: '00000000-0000-0000-0000-000000000001',
  name: 'Main Showroom',
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
  is_active: true,
  archived_at: null,
};

const CLOSED_YARD = {
  ...SHOWROOM,
  id: 'a0000000-0000-0000-0000-0000000000a2',
  name: 'North Yard',
  code: 'YARD',
  is_active: false,
  archived_at: '2026-03-01T00:00:00.000Z',
};

let rows: unknown[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  rows = [SHOWROOM, CLOSED_YARD];
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/locations') return Promise.resolve({ data: rows });
    return Promise.resolve({ data: [] });
  });
  mockApi.post.mockResolvedValue({ data: {} });
});

/** The table row carrying this location's name. */
function rowFor(name: string) {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('Settings > Locations — archived rows stay visible', () => {
  it('lists an archived location rather than hiding it', async () => {
    renderWithProviders(<LocationsPage />);
    expect(await screen.findByText('Main Showroom')).toBeInTheDocument();
    // The whole reason this list is not filtered: an admin looking for the yard they closed has
    // to find it in order to restore it.
    expect(screen.getByText('North Yard')).toBeInTheDocument();
  });

  it('marks the archived one distinctly, so it does not read as bookable', async () => {
    renderWithProviders(<LocationsPage />);
    await screen.findByText('North Yard');

    expect(within(rowFor('North Yard')).getByText(/archived/i)).toBeInTheDocument();
    expect(within(rowFor('Main Showroom')).queryByText(/archived/i)).toBeNull();
  });
});

describe('Settings > Locations — archive and the way back', () => {
  it('archives an active location through its own door', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Showroom');

    await user.click(within(rowFor('Main Showroom')).getByRole('button', { name: /^archive$/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][0]).toBe(`/api/locations/${SHOWROOM.id}/archive`);
  });

  // The BUTTON says "Restore" - the spec's user-facing word, and the better one on a table row.
  // The route it posts to is `unarchive`, matching the customer pair. The divergence is
  // deliberate; the next test is what pins both halves at once.
  it('offers Restore, not Archive, on a location that is already archived', async () => {
    renderWithProviders(<LocationsPage />);
    await screen.findByText('North Yard');

    const row = within(rowFor('North Yard'));
    expect(row.getByRole('button', { name: /restore/i })).toBeInTheDocument();
    // Archiving twice is a no-op that reads like a broken button; more to the point, a branch with
    // no way back is exactly what pushes an admin towards deleting instead.
    expect(row.queryByRole('button', { name: /^archive$/i })).toBeNull();
  });

  it('brings an archived location back through its own door, posting to /unarchive', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LocationsPage />);
    await screen.findByText('North Yard');

    // Pressed by its LABEL, posted to the API's own verb: "Restore" on screen, `unarchive` on the
    // wire, the way `POST /api/customers/:id/unarchive` already reads.
    await user.click(within(rowFor('North Yard')).getByRole('button', { name: /restore/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][0]).toBe(`/api/locations/${CLOSED_YARD.id}/unarchive`);
  });
});

describe('Settings > Locations — delete survives archiving', () => {
  it('still offers Delete, so a location nothing references can be removed outright', async () => {
    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Showroom');

    expect(within(rowFor('Main Showroom')).getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('deletes outright when nothing references it', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockResolvedValue({ data: {} });
    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Showroom');

    await user.click(within(rowFor('Main Showroom')).getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/locations/${SHOWROOM.id}`));
  });

  // The API composes this sentence; the screen has to actually show it. A 409 swallowed into
  // "Failed to delete location" is the dead end again, one layer up.
  it('surfaces the API’s 409 verbatim, archiving hint and all', async () => {
    const user = userEvent.setup();
    mockApi.delete.mockRejectedValue({
      response: {
        status: 409,
        data: {
          error:
            'Cannot delete: this location has 2 users assigned to it and 3 visits booked at it. ' +
            'Archive it instead - it stops appearing when anyone books, and everything already ' +
            'pointing at it keeps reading correctly.',
        },
      },
    });
    renderWithProviders(<LocationsPage />);
    await screen.findByText('Main Showroom');

    await user.click(within(rowFor('Main Showroom')).getByRole('button', { name: /delete/i }));

    const message = await screen.findByText(/cannot delete/i);
    expect(message).toHaveTextContent(/2 users/);
    expect(message).toHaveTextContent(/3 visits/);
    expect(message).toHaveTextContent(/archive it instead/i);
  });
});
