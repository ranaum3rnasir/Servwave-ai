/**
 * VisitLocationField — the two SHARED address controls the one-off reuses.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D4).
 *
 * D4 is the decision that a one-off address is structured and geocoded exactly like every other
 * address in the product: the same `AddressAutocomplete`, into the same five fields, with the same
 * static map beside it. Being ad hoc is a statement about whether the address is SAVED to the
 * organisation's locations list, not about what an address is.
 *
 * Both halves are otherwise untestable in this repo. Places needs a live key, and the map reads a
 * module-scope key CI does not have — so both are mocked HERE, in their own file, leaving
 * `visitLocationField.test.tsx` rendering the real controls unmocked. Two things would ship
 * silently without these:
 *
 *   - `onSelect` is the ONLY path that fills city/state/zip from a suggestion, and it is the
 *     literal wording of the slice's acceptance criterion ("entered through the autocomplete...
 *     lands in the five structured columns, parsed, not as one blob in line 1");
 *   - the map is the half of D4 that was missing entirely — every sibling form renders one beside
 *     its autocomplete, and a one-off the booker cannot see on a map is where a suggestion that
 *     resolved to the wrong Springfield stops being catchable before the email goes out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import type { ParsedAddress } from '@/components/crm/address-autocomplete';
import {
  VisitLocationField,
  SERVICE_ADDRESS_VALUE,
  type VisitLocationValue,
} from '../visitLocationField';

/** What Places hands back for "12 Harbor St": already parsed, five fields, by the real control. */
const SUGGESTION: ParsedAddress = {
  address_line1: '12 Harbor St',
  address_line2: 'Suite 4',
  city: 'Asheville',
  state: 'NC',
  zip: '28801',
};

vi.mock('@/lib/api/locations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/locations')>()),
  useLocations: () => ({ data: [{ id: 'loc-1', name: 'Showroom' }] }),
}));

// Stands in for the Places-backed control, exposing the one thing a test cannot otherwise reach:
// the moment a suggestion is chosen. Everything else about it is the real control's contract - an
// input carrying the id it was given, and free typing through `onChange`.
vi.mock('@/components/crm/address-autocomplete', () => ({
  AddressAutocomplete: ({
    id, value, onChange, onSelect, disabled,
  }: {
    id?: string;
    value: string;
    onChange: (v: string) => void;
    onSelect: (a: ParsedAddress) => void;
    disabled?: boolean;
  }) => (
    <>
      <input id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <button type="button" onClick={() => onSelect(SUGGESTION)}>pick suggestion</button>
    </>
  ),
}));

// The real map returns null unless it has a key AND a locatable address, and the key is read at
// module scope from an env file CI does not carry - so the real component renders nothing there
// and an assertion on it would be green locally and red in CI. This stub keeps the ONE rule that
// matters to a reader of this file (line 1 + city + state, the map's own, pinned in
// components/ui/__tests__/service-location-map.test.tsx) and records what it was handed.
vi.mock('@/components/crm/service-location-map', () => ({
  ServiceLocationMap: ({
    addressLine1, city, state, zip,
  }: {
    addressLine1?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  }) =>
    !addressLine1 || !city || !state ? null : (
      <div
        data-testid="visit-location-map"
        data-query={[addressLine1, city, state, zip].filter(Boolean).join(', ')}
      />
    ),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
});

const EMPTY_ONE_OFF: VisitLocationValue = {
  mode: 'oneoff',
  address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
};

/**
 * Rendered CONTROLLED, the way the booking dialog holds it, rather than asserting on an onChange
 * spy: what the criterion is about is where the parsed halves end up, and only a re-render with
 * the new value can show that the City field now holds "Asheville" instead of it being buried in
 * line 1.
 */
function renderControlled(initial: VisitLocationValue = EMPTY_ONE_OFF) {
  const seen: VisitLocationValue[] = [];
  function Harness() {
    const [value, setValue] = useState<VisitLocationValue>(initial);
    return (
      <VisitLocationField
        idPrefix="test"
        value={value}
        onChange={(next) => { seen.push(next); setValue(next); }}
      />
    );
  }
  renderWithProviders(<Harness />);
  return { seen, user: userEvent.setup() };
}

const fieldValue = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value;

describe('the one-off address, entered through the autocomplete', () => {
  it('lands in all five structured fields, parsed - never one blob in line 1', async () => {
    const { user } = renderControlled();

    await user.click(screen.getByRole('button', { name: /pick suggestion/i }));

    expect(fieldValue('test-oneoff-address_line1')).toBe('12 Harbor St');
    expect(fieldValue('test-oneoff-address_line2')).toBe('Suite 4');
    expect(fieldValue('test-oneoff-city')).toBe('Asheville');
    expect(fieldValue('test-oneoff-state')).toBe('NC');
    expect(fieldValue('test-oneoff-zip')).toBe('28801');
    // Said the other way round, because this is the failure the criterion names: the whole
    // formatted address stuffed into line 1, with the other four left for somebody to retype.
    expect(fieldValue('test-oneoff-address_line1')).not.toContain('Asheville');
    expect(fieldValue('test-oneoff-address_line1')).not.toContain('NC');
  });

  it('reports the choice upward as one value the dialog can post, not five edits', async () => {
    const { seen, user } = renderControlled();

    await user.click(screen.getByRole('button', { name: /pick suggestion/i }));

    // One `onChange`, carrying the whole address: five sequential setField calls would each
    // re-render against a stale value and drop four of them.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ mode: 'oneoff', address: SUGGESTION });
  });

  it('stays editable afterwards, so a suggestion resolved to the wrong city is correctable', async () => {
    const { user } = renderControlled();

    await user.click(screen.getByRole('button', { name: /pick suggestion/i }));
    const city = document.getElementById('test-oneoff-city') as HTMLInputElement;
    await user.clear(city);
    await user.type(city, 'Charlotte');

    expect(fieldValue('test-oneoff-city')).toBe('Charlotte');
    expect(fieldValue('test-oneoff-address_line1')).toBe('12 Harbor St');
  });
});

describe('the static map, which is the other half of D4', () => {
  it('renders beside a complete one-off address, on the same four fields the siblings map', async () => {
    const { user } = renderControlled();

    await user.click(screen.getByRole('button', { name: /pick suggestion/i }));

    // `get`, not `find`: userEvent has already flushed the re-render, so an async query would only
    // make a genuine failure sit out the whole async timeout before reporting itself.
    const map = screen.getByTestId('visit-location-map');
    // Line 1, city, state, zip - and NOT the unit, which confuses geocoding and which the shared
    // component deliberately takes no prop for.
    expect(map.getAttribute('data-query')).toBe('12 Harbor St, Asheville, NC, 28801');
    expect(map.getAttribute('data-query')).not.toContain('Suite 4');
  });

  it('shows nothing while the one-off address is still too incomplete to locate', () => {
    renderControlled({
      mode: 'oneoff',
      address: { address_line1: '12 Harbor St', address_line2: '', city: '', state: '', zip: '' },
    });

    expect(screen.queryByTestId('visit-location-map')).toBeNull();
  });

  it('shows no map for the service address - that address is not this control’s to draw', () => {
    renderControlled(SERVICE_ADDRESS_VALUE);
    expect(screen.queryByTestId('visit-location-map')).toBeNull();
  });

  it('shows no map for a company location, whose address this control never holds', () => {
    // D2: the value is a POINTER. The picker resolves the name from the id and the address lives
    // in Settings, so there is nothing here to map without snapshotting it.
    renderControlled({ mode: 'company', locationId: 'loc-1' });
    expect(screen.queryByTestId('visit-location-map')).toBeNull();
  });
});
