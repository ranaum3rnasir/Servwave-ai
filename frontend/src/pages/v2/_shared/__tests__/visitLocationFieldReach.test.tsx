// The visit-location picker lists the organisation's locations only for a person who may read them (View locations).
// Without that grant the server refuses `GET /api/locations`, so the control must not ask: it shows its two other
// options and nothing else changes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { SERVICE_ADDRESS_VALUE, VisitLocationField } from '../visitLocationField';

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: [{ id: 'loc-1', name: 'Showroom' }] });
});

function locationReads() {
  return mockApi.get.mock.calls.map(([url]) => url).filter((url) => url === '/api/locations');
}

describe('VisitLocationField reads locations only when the person may', () => {
  it('asks for the locations when the person holds View locations', async () => {
    renderWithProviders(
      <VisitLocationField value={SERVICE_ADDRESS_VALUE} onChange={() => {}} />,
      { ability: buildAbility([{ action: 'read', subject: 'Location' }]) },
    );
    await waitFor(() => expect(locationReads()).toHaveLength(1));
  });

  it('makes no request when the person does not', async () => {
    renderWithProviders(
      <VisitLocationField value={SERVICE_ADDRESS_VALUE} onChange={() => {}} />,
      { ability: buildAbility([{ action: 'read', subject: 'Job' }]) },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(locationReads()).toEqual([]);
  });
});
