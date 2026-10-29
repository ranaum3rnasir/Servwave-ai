/**
 * VisitLocationField — "where is this visit happening", the one control the booking dialog gains.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md
 *
 * The failure modes are all customer-facing, because whatever this control produces is what an
 * automation puts in a confirmation email:
 *
 *   - defaulting to anything but the service address changes what every existing booking means;
 *   - a bare text input for the one-off would be the only address in the product that does not
 *     autocomplete, parse or map (D4), and would post one blob in line 1;
 *   - seeding from nothing would make "change only the time" silently move a showroom meeting
 *     back to the customer's house.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import {
  VisitLocationField,
  seedVisitLocation,
  visitLocationPayload,
  isVisitLocationComplete,
  SERVICE_ADDRESS_VALUE,
  type VisitLocationValue,
} from '../visitLocationField';

const BLANK_ONE_OFF = {
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
};

const SHOWROOM = { id: 'loc-1', name: 'Showroom' };
const YARD = { id: 'loc-2', name: 'North Yard' };

// `is_active` is optional here on purpose: rows written before slice 2's column existed, and every
// older test stub, carry no such key, and the control has to read that as bookable.
const locationState = vi.hoisted(() => ({
  list: [] as { id: string; name: string; is_active?: boolean }[],
}));

vi.mock('@/lib/api/locations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/locations')>()),
  useLocations: () => ({ data: locationState.list }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  vi.clearAllMocks();
  locationState.list = [SHOWROOM, YARD];
});

function renderField(value: VisitLocationValue = SERVICE_ADDRESS_VALUE) {
  const onChange = vi.fn();
  renderWithProviders(
    <VisitLocationField idPrefix="test" value={value} onChange={onChange} />,
  );
  return { onChange, user: userEvent.setup() };
}

/**
 * The control wired the way the booking dialog actually wires it - value in state, so a pick
 * genuinely changes the value the control is handed NEXT.
 *
 * `renderField` above holds `value` fixed, which is right for every single-render assertion and
 * structurally blind to anything that only goes wrong on the SECOND pick. The archived-location
 * exception was exactly that: correct on the render the dialog opens with, gone one click later.
 */
function ControlledField({ initial }: { initial: VisitLocationValue }) {
  const [value, setValue] = useState<VisitLocationValue>(initial);
  return <VisitLocationField idPrefix="test" value={value} onChange={setValue} />;
}

function renderControlled(initial: VisitLocationValue) {
  renderWithProviders(<ControlledField initial={initial} />);
  return { user: userEvent.setup() };
}

const picker = () => screen.getByRole('combobox', { name: /location/i });

describe('VisitLocationField — the three choices', () => {
  it('defaults to the service address, so the great majority of visits need no decision', () => {
    renderField();
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('offers the organisation’s own locations by name', async () => {
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));
    expect(await screen.findByRole('option', { name: 'Showroom' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'North Yard' })).toBeInTheDocument();
  });

  it('offers only the two other options when the organisation has no locations', async () => {
    locationState.list = [];
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([expect.stringMatching(/service address/i)]),
    );
  });

  /**
   * Ran, 2026-09-15: "A different address" was being read as a fourth PLACE rather than as the
   * door to typing one, so the wording became "Other" and the row is set apart from its siblings.
   *
   * Two assertions, because either alone passes on a build that has lost the point. The word
   * without the emphasis is a shorter noun phrase in the same weight as the locations above it -
   * which is the original defect, only harder to spot. The emphasis without the word is a bold
   * sentence where a label belongs. The siblings are checked too: emphasis on everything is
   * emphasis on nothing.
   */
  it('names the one-off "Other…" and sets it apart from the places, which is the whole point', async () => {
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    const other = await screen.findByRole('option', { name: 'Other…' });
    expect(other.querySelector('.font-semibold')?.textContent).toBe('Other…');

    for (const name of ['Service address', 'Showroom', 'North Yard']) {
      const place = screen.getByRole('option', { name });
      expect(place.querySelector('.font-semibold'), `${name} must not be emphasised`).toBeNull();
    }
  });

  /**
   * Ran's third refinement, 2026-09-15: closed, the control should state its VALUE. "Other…" is
   * the right word to pick from a list and a non-answer to read back out of a collapsed picker
   * once the person has typed an actual address.
   *
   * The empty case is the half that matters more. A control that went blank the instant somebody
   * chose "Other…" - before they had typed anything - would look broken at exactly the moment
   * they were being asked to type, so the fallback to the label is the behaviour, not a nicety.
   */
  it('reads back the typed address once there is one, and "Other…" until then', () => {
    renderField({ mode: 'oneoff', address: { ...BLANK_ONE_OFF } });
    expect(picker()).toHaveTextContent('Other…');
    cleanup();

    renderField({
      mode: 'oneoff',
      address: {
        address_line1: '12 Harbor St', address_line2: 'Unit 4',
        city: 'Asheville', state: 'NC', zip: '28801',
      },
    });
    // Line 1, city and state, in the order every other address in the product renders. The unit
    // and the ZIP are deliberately absent: this is a one-line identity in a control, and a
    // collapsed picker reading "12 Harbor St, Unit 4, Asheville, NC 28801" is a mailing label.
    expect(picker()).toHaveTextContent('12 Harbor St, Asheville, NC');
    expect(picker()).not.toHaveTextContent('Unit 4');
    expect(picker()).not.toHaveTextContent('28801');
  });

  it('ends the list of places with a rule, so the alternative sits outside it', async () => {
    const { user } = renderField();
    await user.click(picker());

    await screen.findByRole('option', { name: 'Other…' });
    expect(document.querySelectorAll('[data-slot="select-separator"]')).toHaveLength(1);
  });

  it('survives a locations response that is not an array, rather than blanking the page', () => {
    // Found the hard way: `?? []` let a `{}` through and `.map` took the WHOLE lead page down,
    // not just the picker. The control is embedded in a record page, so degrading to its two
    // other options is the only acceptable failure.
    locationState.list = {} as never;
    renderField();
    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/service address/i);
  });

  it('reveals the shared address autocomplete for a one-off, not a bare text input', () => {
    renderField({ mode: 'oneoff', address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' } });
    // The same control the lead, customer and job forms use. Identified by its own field id
    // rather than by a placeholder, so re-wording the placeholder does not silently pass.
    expect(document.getElementById('test-oneoff-address_line1')).toBeTruthy();
    // ...and the parsed halves it fills in are on screen, so a selected suggestion is visible and
    // correctable rather than collapsed into one blob.
    expect(document.getElementById('test-oneoff-city')).toBeTruthy();
    expect(document.getElementById('test-oneoff-state')).toBeTruthy();
  });

  it('shows no address fields at all while the service address is chosen', () => {
    renderField();
    expect(document.getElementById('test-oneoff-address_line1')).toBeNull();
  });
});

// ── Archived locations (slice 2) ────────────────────────────────────────────
//
// This is the ONE booking picker in the feature, so it is the one place the active filter belongs
// on the read side - and the place getting it backwards costs the most. Leave the filter out and
// an office books a design consultation into a branch that closed in March; apply it to the
// SEEDED value as well and the visit already booked there loses its location the moment anybody
// opens the dialog, then posts the customer's own house over it on save.

describe('VisitLocationField — an archived location', () => {
  it('drops out of the picker, so nobody books into a closed branch', async () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: false }];
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    expect(await screen.findByRole('option', { name: 'Showroom' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /North Yard/ })).not.toBeInTheDocument();
  });

  it('comes back in the picker once it is restored', async () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: true }];
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    expect(await screen.findByRole('option', { name: 'North Yard' })).toBeInTheDocument();
  });

  // A location with no `is_active` key at all is a row from before this feature, or a stub in an
  // older test. It is bookable: reading "absent" as "archived" would empty every picker.
  it('treats a location with no is_active field as bookable', async () => {
    locationState.list = [SHOWROOM, YARD];
    const { user } = renderField();
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    expect(await screen.findByRole('option', { name: 'North Yard' })).toBeInTheDocument();
  });

  // The other direction, and the expensive one. This visit was booked at the yard before it
  // closed; the customer has been told to come there. The control still has to SAY so.
  it('still shows the location a visit is already booked at, archived or not', () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: false }];
    renderField({ mode: 'company', locationId: YARD.id });

    // Not blank, and not silently reset to the service address - either would be the form posting
    // the customer's own address over a place they have already been sent to.
    const picker = screen.getByRole('combobox', { name: /location/i });
    expect(picker).toHaveTextContent(/North Yard/);
    expect(picker).not.toHaveTextContent(/service address/i);
  });

  it('marks that already-booked location as archived rather than passing it off as bookable', () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: false }];
    renderField({ mode: 'company', locationId: YARD.id });

    expect(screen.getByRole('combobox', { name: /location/i })).toHaveTextContent(/archived/i);
  });

  // THE MISCLICK, and it is the whole reason the exception is keyed off the SEED rather than off
  // the live value. The walkthrough is booked at the yard, the yard has closed, the customer has
  // been told to come there. The office opens Reschedule, clicks the wrong row, and reaches
  // straight back for the dropdown to undo it. Keyed off `value.locationId`, the yard is gone the
  // instant they click away - there is no undo, and pressing Save posts `location: null`, which
  // the API accepts as a deliberate clear. A confirmed yard meeting becomes the customer's own
  // house, silently, which is the exact D9 failure the seed exists to prevent.
  it('still offers the seeded archived location after somebody switches away from it', async () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: false }];
    const { user } = renderControlled({ mode: 'company', locationId: YARD.id });

    // The misclick.
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: /service address/i }));
    expect(picker()).toHaveTextContent(/service address/i);

    // Reaching back for it: it has to still be on offer, and still labelled for what it is.
    await user.click(picker());
    const yardOption = await screen.findByRole('option', { name: /North Yard/ });
    expect(yardOption).toHaveTextContent(/archived/i);
  });

  it('puts the visit back at the seeded archived location when the undo is clicked', async () => {
    locationState.list = [SHOWROOM, { ...YARD, is_active: false }];
    const { user } = renderControlled({ mode: 'company', locationId: YARD.id });

    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: /service address/i }));
    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: /North Yard/ }));

    // Back where the customer was told to go, not left on the service address.
    expect(picker()).toHaveTextContent(/North Yard/);
    expect(picker()).not.toHaveTextContent(/service address/i);
  });

  // The seed is a courtesy for ONE location, and switching away must not turn it into a general
  // amnesty. A branch that closed and was never this visit's own stays out however the picker is
  // driven.
  it('does not start offering other archived locations once the seeded one is deselected', async () => {
    locationState.list = [
      SHOWROOM,
      { ...YARD, is_active: false },
      { id: 'loc-3', name: 'Old Depot', is_active: false },
    ];
    const { user } = renderControlled({ mode: 'company', locationId: YARD.id });

    await user.click(picker());
    await user.click(await screen.findByRole('option', { name: /service address/i }));
    await user.click(picker());

    expect(await screen.findByRole('option', { name: /North Yard/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old Depot/ })).not.toBeInTheDocument();
  });

  it('does not offer any OTHER archived location just because one is seeded', async () => {
    locationState.list = [
      { ...YARD, is_active: false },
      { id: 'loc-3', name: 'Old Depot', is_active: false },
    ];
    const { user } = renderField({ mode: 'company', locationId: YARD.id });
    await user.click(screen.getByRole('combobox', { name: /location/i }));

    expect(await screen.findByRole('option', { name: /North Yard/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old Depot/ })).not.toBeInTheDocument();
  });
});

describe('visitLocationPayload — what reaches the API', () => {
  it('sends explicit null for the service address, which is the "clear it" signal', () => {
    expect(visitLocationPayload(SERVICE_ADDRESS_VALUE)).toBeNull();
  });

  it('sends the id alone for a company location — a pointer, never a copy of its address', () => {
    expect(visitLocationPayload({ mode: 'company', locationId: 'loc-1' })).toEqual({
      location_id: 'loc-1',
    });
  });

  it('sends the one-off as five structured fields, never one blob', () => {
    expect(
      visitLocationPayload({
        mode: 'oneoff',
        address: {
          address_line1: '12 Harbor St',
          address_line2: 'Suite 4',
          city: 'Asheville',
          state: 'NC',
          zip: '28801',
        },
      }),
    ).toEqual({
      address_line1: '12 Harbor St',
      address_line2: 'Suite 4',
      city: 'Asheville',
      state: 'NC',
      zip: '28801',
    });
  });

  it('omits a blank optional rather than sending an empty string', () => {
    const payload = visitLocationPayload({
      mode: 'oneoff',
      address: { address_line1: '12 Harbor St', address_line2: '', city: 'Asheville', state: 'NC', zip: '' },
    }) as Record<string, unknown>;
    expect(payload.address_line2).toBeUndefined();
    expect(payload.zip).toBeUndefined();
  });
});

describe('isVisitLocationComplete — what Book may be pressed on', () => {
  it('accepts the service address and a chosen company location', () => {
    expect(isVisitLocationComplete(SERVICE_ADDRESS_VALUE)).toBe(true);
    expect(isVisitLocationComplete({ mode: 'company', locationId: 'loc-1' })).toBe(true);
  });

  it('refuses a half-typed one-off, matching the API’s own rule', () => {
    const half = (over: Partial<Record<string, string>>) =>
      isVisitLocationComplete({
        mode: 'oneoff',
        address: {
          address_line1: '12 Harbor St', address_line2: '', city: 'Asheville', state: 'NC', zip: '',
          ...over,
        } as never,
      });
    expect(half({})).toBe(true);
    expect(half({ address_line1: '' })).toBe(false);
    expect(half({ city: '' })).toBe(false);
    expect(half({ state: '' })).toBe(false);
  });
});

describe('seedVisitLocation — the reason a reschedule does not move the meeting', () => {
  it('reads a stored company location back as the company choice', () => {
    expect(seedVisitLocation({ location_id: 'loc-1', address_line1: null, address_line2: null, city: null, state: null, zip: null }))
      .toEqual({ mode: 'company', locationId: 'loc-1' });
  });

  it('reads a stored one-off back as the one-off choice, field for field', () => {
    expect(
      seedVisitLocation({
        location_id: null,
        address_line1: '12 Harbor St',
        address_line2: 'Suite 4',
        city: 'Asheville',
        state: 'NC',
        zip: '28801',
      }),
    ).toEqual({
      mode: 'oneoff',
      address: {
        address_line1: '12 Harbor St', address_line2: 'Suite 4',
        city: 'Asheville', state: 'NC', zip: '28801',
      },
    });
  });

  it('reads null and undefined as the service address', () => {
    expect(seedVisitLocation(null)).toEqual(SERVICE_ADDRESS_VALUE);
    expect(seedVisitLocation(undefined)).toEqual(SERVICE_ADDRESS_VALUE);
  });
});
