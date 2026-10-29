import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import type { ParsedAddress } from '@/components/crm/address-autocomplete';

// The component reads the Places key from import.meta.env at module scope, so it
// has to be stubbed before the module is imported.
async function loadComponent() {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'test-key');
  vi.resetModules();
  const mod = await import('@/components/crm/address-autocomplete');
  return mod.AddressAutocomplete;
}

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';

/** A point of interest: Google returns no street_number and no route. */
const TERMINAL_SUGGESTION = {
  placePrediction: {
    placeId: 'place-jfk-t5',
    text: { text: 'JFK Terminal 5, Queens, NY, USA' },
    structuredFormat: {
      mainText: { text: 'JFK Terminal 5' },
      secondaryText: { text: 'Queens, NY, USA' },
    },
  },
};

const TERMINAL_DETAILS = {
  formattedAddress: 'JFK Terminal 5, Queens, NY 11430, USA',
  addressComponents: [
    { longText: 'Queens', shortText: 'Queens', types: ['sublocality_level_1'] },
    { longText: 'New York', shortText: 'NY', types: ['administrative_area_level_1'] },
    { longText: '11430', shortText: '11430', types: ['postal_code'] },
  ],
};

const STREET_SUGGESTION = {
  placePrediction: {
    placeId: 'place-street',
    text: { text: '100 Main St, Austin, TX, USA' },
    structuredFormat: {
      mainText: { text: '100 Main St' },
      secondaryText: { text: 'Austin, TX, USA' },
    },
  },
};

const STREET_DETAILS = {
  formattedAddress: '100 Main St, Austin, TX 78701, USA',
  addressComponents: [
    { longText: '100', shortText: '100', types: ['street_number'] },
    { longText: 'Main Street', shortText: 'Main St', types: ['route'] },
    { longText: 'Austin', shortText: 'Austin', types: ['locality'] },
    { longText: 'Texas', shortText: 'TX', types: ['administrative_area_level_1'] },
    { longText: '78701', shortText: '78701', types: ['postal_code'] },
  ],
};

function mockPlaces(suggestion: unknown, details: unknown) {
  const fetchMock = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (url === AUTOCOMPLETE_URL ? { suggestions: [suggestion] } : details),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The field is controlled, so it needs a stateful owner to accumulate typing. */
function Harness({
  Component,
  onSelect,
}: {
  Component: typeof import('@/components/crm/address-autocomplete').AddressAutocomplete;
  onSelect: (address: ParsedAddress) => void;
}) {
  const [value, setValue] = useState('');
  return <Component value={value} onChange={setValue} onSelect={onSelect} />;
}

/** Types a query, waits for the dropdown, and clicks the single suggestion. */
async function selectFirstSuggestion(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.type(screen.getByRole('textbox'), 'query text');
  const option = await screen.findByRole('button', { name: new RegExp(label) });
  await user.click(option);
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('AddressAutocomplete', () => {
  it('keeps the place name as line 1 when the place has no street number or route', async () => {
    const AddressAutocomplete = await loadComponent();
    mockPlaces(TERMINAL_SUGGESTION, TERMINAL_DETAILS);
    const onSelect = vi.fn<[ParsedAddress], void>();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderWithProviders(<Harness Component={AddressAutocomplete} onSelect={onSelect} />);

    await selectFirstSuggestion(user, 'JFK Terminal 5');

    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    expect(onSelect.mock.calls[0][0]).toEqual({
      address_line1: 'JFK Terminal 5',
      address_line2: '',
      city: 'Queens',
      state: 'NY',
      zip: '11430',
    });
  });

  it('still uses the street number and route for a regular street address', async () => {
    const AddressAutocomplete = await loadComponent();
    mockPlaces(STREET_SUGGESTION, STREET_DETAILS);
    const onSelect = vi.fn<[ParsedAddress], void>();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderWithProviders(<Harness Component={AddressAutocomplete} onSelect={onSelect} />);

    await selectFirstSuggestion(user, '100 Main St');

    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    expect(onSelect.mock.calls[0][0]).toEqual({
      address_line1: '100 Main Street',
      address_line2: '',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
    });
  });
});
