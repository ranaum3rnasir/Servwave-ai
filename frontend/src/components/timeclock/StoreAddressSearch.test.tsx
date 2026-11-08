import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { StoreAddressValue } from './StoreAddressSearch';

/**
 * Guard: with NO Google Maps API key configured (issue #26), the store-address
 * picker must NOT invent data. Live clients would otherwise see fabricated
 * address suggestions (8 hardcoded US landmarks) and fabricated coordinates.
 *
 * The local .env sets a real key, so we stub it empty BEFORE importing the
 * component (its module-level API_KEY const reads env at import time) to force
 * the keyless path.
 */
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderKeyless(props: {
  value: StoreAddressValue;
  onChange: (next: StoreAddressValue) => void;
}) {
  const { StoreAddressSearch } = await import('./StoreAddressSearch');
  render(<StoreAddressSearch {...props} />);
}

describe('StoreAddressSearch — no fabricated data without a Maps API key', () => {
  it('does not surface fabricated address suggestions when typing', async () => {
    const user = userEvent.setup();
    await renderKeyless({ value: { address: '', lat: 0, lng: 0 }, onChange: () => {} });

    await user.type(screen.getByRole('combobox'), 'World');

    // No fabricated suggestion dropdown (e.g. "1 World Trade Center") may appear.
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('does not fabricate coordinates for a typed address', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    await renderKeyless({ value: { address: '', lat: 0, lng: 0 }, onChange });

    await user.type(screen.getByRole('combobox'), '123 Main St');

    // Every emitted value keeps the caller-supplied coords — no derived NYC-ish fakes.
    expect(onChange).toHaveBeenCalled();
    for (const [next] of onChange.mock.calls) {
      expect(next.lat).toBe(0);
      expect(next.lng).toBe(0);
    }
  });
});
