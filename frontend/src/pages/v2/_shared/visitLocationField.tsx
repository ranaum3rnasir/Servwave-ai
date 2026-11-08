import { useState } from 'react';

import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import { ServiceLocationMap } from '@/components/crm/service-location-map';
import { isBookableLocation, useLocations } from '@/lib/api/locations';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

/**
 * "Where is this visit happening" - the one control the booking dialogs gain.
 *
 * Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md.
 *
 * THREE CHOICES, and the default is the one that changes nothing: the parent's service address,
 * which is where the great majority of visits happen and what every booking made before this
 * feature means. The other two are one of the organisation's own locations - the showroom, the
 * yard, the second branch - and "Other", which is not a place at all but the door to a one-off
 * address for a trip happening somewhere that is neither.
 *
 * The one-off is entered through `AddressAutocomplete`, the SAME control the lead, customer and
 * job forms use, into the SAME five structured fields, and shows the SAME `ServiceLocationMap`
 * beside it (D4). That is the point of the decision rather than a detail of it: an address that
 * did not autocomplete, parse or map would be the only such address in the product, and it would
 * post one blob in line 1 where every sibling posts five fields.
 *
 * It is NOT saved into the organisation's locations list. An address used once should not
 * permanently enlarge a picker every colleague sees.
 *
 * Lives in `_shared/` because the job side and the additional-visit door get the same control in
 * later slices, and a second copy is how the two would drift.
 */

/** The five structured fields, exactly as `AddressAutocomplete` parses them. */
export interface VisitOneOffAddress {
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
}

/**
 * The control's value. A discriminated union rather than "an id that might be a sentinel": the
 * three states are genuinely different shapes, and the API's own field is a union for the same
 * reason.
 */
export type VisitLocationValue =
  | { mode: 'service' }
  | { mode: 'company'; locationId: string }
  | { mode: 'oneoff'; address: VisitOneOffAddress };

export const SERVICE_ADDRESS_VALUE: VisitLocationValue = { mode: 'service' };

/**
 * The only part of a location this picker reads. Structural rather than the full `Location`, so
 * the option list keeps working against any row carrying these three - and `is_active` is optional
 * for the same reason it is optional on `Location`: a row written before slice 2 has no such key
 * and is bookable.
 */
type LocationOption = { id: string; name: string; is_active?: boolean };

const EMPTY_ADDRESS: VisitOneOffAddress = {
  address_line1: '', address_line2: '', city: '', state: '', zip: '',
};

/** Select sentinels. Location ids are uuids, so neither can collide with one. */
const SERVICE_OPTION = '__service__';
const ONE_OFF_OPTION = '__oneoff__';

/** The visit's stored location, as `walkthrough_location` arrives on the record. */
export interface StoredVisitLocation {
  location_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * Seed the control from what is STORED, and this is the function that keeps the form honest.
 *
 * The control defaults to the service address and the form states its location on every save, so
 * a Reschedule opened on a showroom booking without this would post "service address" and send
 * the customer to their own house after they had been told to come to the showroom. The API's
 * omitted-means-unchanged rule cannot help a form that always states one.
 *
 * `null` is a fact - the visit is at the service address. `undefined` means the record never
 * carried the field, and reads the same way, because a form with no seed to work from has
 * nothing better to offer than the default.
 */
export function seedVisitLocation(
  stored: StoredVisitLocation | null | undefined,
): VisitLocationValue {
  if (!stored) return SERVICE_ADDRESS_VALUE;
  if (stored.location_id) return { mode: 'company', locationId: stored.location_id };
  if (stored.address_line1) {
    return {
      mode: 'oneoff',
      address: {
        address_line1: stored.address_line1,
        address_line2: stored.address_line2 ?? '',
        city: stored.city ?? '',
        state: stored.state ?? '',
        zip: stored.zip ?? '',
      },
    };
  }
  return SERVICE_ADDRESS_VALUE;
}

/**
 * The `location` key for a booking body.
 *
 * `null` for the service address, deliberately, and NOT an omitted key: this form always states
 * where, so "the service address" is a statement that clears whatever was stored, which is what
 * the person looking at the control just chose. Omitting is the API's "I am not talking about the
 * location" and belongs to callers that genuinely are not - not to this one.
 *
 * A company location sends the ID ALONE. Sending its address too would be a snapshot, and the
 * whole point of the pointer is that correcting the showroom's address in Settings fixes
 * tomorrow's unsent reminder.
 *
 * A blank optional is omitted rather than sent as '': the API stores what it is given, and an
 * empty string in `location_zip` is a value that renders as one.
 */
export function visitLocationPayload(
  value: VisitLocationValue,
): null | { location_id: string } | Partial<VisitOneOffAddress> {
  if (value.mode === 'service') return null;
  if (value.mode === 'company') return { location_id: value.locationId };
  const { address_line1, address_line2, city, state, zip } = value.address;
  return {
    address_line1,
    ...(address_line2 ? { address_line2 } : {}),
    city,
    state,
    ...(zip ? { zip } : {}),
  };
}

/**
 * Whether this value can be posted at all - the same rule the API's schema applies, restated here
 * so Book is disabled rather than answering 400.
 *
 * Line 1, city and state together, because a half-typed address cannot be stored and because a
 * one-off missing its city renders "12 Harbor St, , NC" in the customer's email.
 */
export function isVisitLocationComplete(value: VisitLocationValue): boolean {
  if (value.mode !== 'oneoff') return true;
  const { address_line1, city, state } = value.address;
  return Boolean(address_line1.trim() && city.trim() && state.trim());
}

export interface VisitLocationFieldProps {
  value: VisitLocationValue;
  onChange: (value: VisitLocationValue) => void;
  disabled?: boolean;
  /** DOM id prefix, so two of these on one page do not collide. */
  idPrefix?: string;
  label?: string;
}

export function VisitLocationField({
  value, onChange, disabled = false, idPrefix = 'visit-location', label = 'Location',
}: VisitLocationFieldProps) {
  // An organisation with no locations configured simply sees the two other options. That is
  // honest and needs no special-casing: the picker is shorter, and nothing claims otherwise.
  //
  // `Array.isArray`, not `?? []`: this control sits inside a lead page, and a `GET /api/locations`
  // that answered anything but an array - an error envelope, a paginated `{ items }`, a stub - used
  // to take `.map` with it and blank the WHOLE PAGE, not just the picker. A picker that renders
  // its two other options is a far better failure than a lead nobody can open.
  const { data: locations } = useLocations();
  const allLocations = Array.isArray(locations) ? locations : [];

  const selected =
    value.mode === 'company' ? value.locationId
      : value.mode === 'oneoff' ? ONE_OFF_OPTION
        : SERVICE_OPTION;

  /**
   * The location this control OPENED on, held for the life of the dialog.
   *
   * `useState` with a lazy initialiser and no setter - React's own way to capture a value at
   * mount and keep it. Deliberately not a `useRef`: this is read DURING RENDER, to build the
   * option list, and `react-hooks/refs` refuses that (correctly - a ref's value is not something
   * render may depend on). The value is captured from the FIRST value the control is handed,
   * which is the seeded one: the parent sets its location from the stored visit in the same
   * handler that opens the booking form, so this mounts already holding it (walkthroughTab's
   * `openReschedule`). A control that is not open is not mounted, so "the life of the dialog" and
   * "the life of this component" are the same lifetime.
   *
   * It exists because reading the exception back off the LIVE value instead is one misclick from
   * losing a booking. See the option list below.
   */
  const [seededLocationId] = useState(() => (value.mode === 'company' ? value.locationId : null));

  /**
   * ARCHIVED LOCATIONS LEAVE THIS PICKER, which is the point of slice 2 (D9). A branch that has
   * closed must stop being offered, or an office books a design consultation into it and the
   * confirmation sends the customer to a locked door.
   *
   * ...WITH ONE EXCEPTION, and getting THAT wrong is expensive in the other direction. The visit
   * this dialog is open on may already be booked at a location archived since - the customer has
   * been told to come there. Dropping it would leave the control holding a value it has no option
   * for, which renders as blank or reads back as "Service address", and this form states its
   * location on EVERY save: the next Save would post the customer's own house over a place they
   * have already been sent to. So the one it is standing at stays, labelled for what it is, and no
   * other archived location comes with it.
   *
   * THE EXCEPTION IS KEYED OFF THE SEED, NOT OFF THE CURRENT SELECTION, and the difference is one
   * misclick wide. Keyed off `value.locationId`, the archived branch stops matching the instant
   * anybody picks something else - so it LEAVES THE OPTION LIST, and the undo they immediately
   * reach for is not there. The only way back would be to cancel the whole dialog; press Save
   * instead and the form posts `location: null`, which the API accepts as a deliberate clear, and
   * a confirmed yard meeting silently becomes the customer's own house. That is the exact D9
   * failure the seed exists to prevent, re-entered through the door meant to close it. Held as
   * the seed, switching away and back is free.
   *
   * This is a filter over what the API already returned, never a second request: `GET
   * /api/locations` is deliberately unfiltered, because Settings needs the archived rows in order
   * to offer the way back. The booking rule lives at the booking picker. And it is a COURTESY, not
   * the guard - the refusal that counts is `resolveVisitLocationWrite` at the API, because a tab
   * opened before the branch closed still holds the stale option.
   */
  const orgLocations = allLocations.filter(
    (loc) => isBookableLocation(loc) || loc.id === seededLocationId,
  );

  /** Never passes an archived location off as bookable - the reason it is still listed is visible. */
  const labelFor = (loc: LocationOption) => (isBookableLocation(loc) ? loc.name : `${loc.name} (archived)`);

  const pick = (next: string) => {
    if (next === SERVICE_OPTION) { onChange(SERVICE_ADDRESS_VALUE); return; }
    // A fresh, EMPTY address rather than one carried over from a previous choice: the person
    // switching to a one-off is naming a different place, and pre-filling it from the location
    // they just left is the kind of seeded default that becomes an unintended write.
    if (next === ONE_OFF_OPTION) { onChange({ mode: 'oneoff', address: { ...EMPTY_ADDRESS } }); return; }
    onChange({ mode: 'company', locationId: next });
  };

  const setField = (field: keyof VisitOneOffAddress, val: string) => {
    if (value.mode !== 'oneoff') return;
    onChange({ mode: 'oneoff', address: { ...value.address, [field]: val } });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${idPrefix}-picker`}>{label}</Label>
      <SelectField
        id={`${idPrefix}-picker`}
        aria-label={label}
        value={selected}
        onValueChange={pick}
        disabled={disabled}
        options={[
          { value: SERVICE_OPTION, label: 'Service address' },
          ...orgLocations.map((loc) => ({ value: loc.id, label: labelFor(loc) })),
          // THE ONE ROW THAT IS NOT A PLACE, and three separate things say so (Ran,
          // 2026-09-15). Every other row NAMES somewhere - the service address, the showroom, the
          // yard - so "A different address" was a noun phrase sitting among noun phrases and got
          // read as a fourth location. Now:
          //
          //   the WORD is "Other", and the trailing ellipsis is the convention every desktop
          //   platform uses for "choosing this asks you for more" - it reads as an action before
          //   anybody has parsed the sentence;
          //
          //   the WEIGHT is semibold, so the row is visibly a different kind of thing from the
          //   places above it;
          //
          //   the RULE above it ends the list of places, so the alternative sits outside it.
          //
          // All three come from the kit and therefore hold on both sides of the 10-option rule:
          // an organisation with nine locations renders this picker as a searchable combobox
          // instead, and the one row that is not a location must not lose its distinction on
          // exactly the accounts with the longest list to read.
          {
            value: ONE_OFF_OPTION,
            label: 'Other…',
            emphasis: true,
            separatorBefore: true,
            // CLOSED, THE CONTROL STATES ITS VALUE; OPEN, IT STATES ITS CHOICES. "Other…" is the
            // right word to pick from a list and the wrong thing to read back out of a collapsed
            // picker, where the honest answer is the address the person went on to type. Line 1,
            // city and state in the order every other address in the product renders, and NOT the
            // unit or the ZIP: this is a one-line identity in a control, not a mailing label.
            // Empty until something is typed, and the kit falls back to the label for that - a
            // one-off with nothing in it yet still reads "Other…" rather than as a blank control.
            triggerLabel:
              value.mode === 'oneoff'
                ? [value.address.address_line1, value.address.city, value.address.state]
                    .map((part) => part.trim())
                    .filter(Boolean)
                    .join(', ')
                : '',
          },
        ]}
      />

      {value.mode === 'oneoff' && (
        <div className="mt-1.5 flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_80px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-oneoff-address_line1`}>Address</Label>
              {/* The app's Google Places control, reused rather than rebuilt - an address entered
                  here has to autocomplete, parse and map exactly like any other address. */}
              <AddressAutocomplete
                id={`${idPrefix}-oneoff-address_line1`}
                disabled={disabled}
                value={value.address.address_line1}
                onChange={(val) => setField('address_line1', val)}
                onSelect={(place) => {
                  // Every parsed field at once - a suggestion selected has to land in all five,
                  // not leave the city and state to be typed by hand under a filled line 1.
                  onChange({
                    mode: 'oneoff',
                    address: {
                      address_line1: place.address_line1,
                      address_line2: place.address_line2 || '',
                      city: place.city,
                      state: place.state,
                      zip: place.zip,
                    },
                  });
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-oneoff-address_line2`}>Unit</Label>
              <Input
                id={`${idPrefix}-oneoff-address_line2`}
                disabled={disabled}
                value={value.address.address_line2}
                onChange={(e) => setField('address_line2', e.target.value)}
              />
            </div>
          </div>

          {/* The parsed halves stay VISIBLE and editable. A suggestion that resolves to the wrong
              city is correctable here rather than only after the confirmation has gone out. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-oneoff-city`}>City</Label>
              <Input
                id={`${idPrefix}-oneoff-city`}
                disabled={disabled}
                value={value.address.city}
                onChange={(e) => setField('city', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-oneoff-state`}>State</Label>
              <Input
                id={`${idPrefix}-oneoff-state`}
                disabled={disabled}
                maxLength={2}
                value={value.address.state}
                onChange={(e) => setField('state', e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-oneoff-zip`}>ZIP</Label>
              <Input
                id={`${idPrefix}-oneoff-zip`}
                disabled={disabled}
                value={value.address.zip}
                onChange={(e) => setField('zip', e.target.value)}
              />
            </div>
          </div>

          {/* THE SAME STATIC MAP the lead, customer and job forms render beside their own address
              autocomplete (D4). Being ad hoc is a statement about whether the address is saved to
              the locations list, not about what an address IS - a one-off the person booking
              cannot see on a map would be the only address in the product that behaves that way,
              and the map is where a suggestion that resolved to the wrong Springfield gets caught
              BEFORE the confirmation goes out.

              Rendered unconditionally, exactly as the sibling forms render it: the component owns
              the "is there enough to geocode" rule (line 1 + city + state, no unit) and returns
              null until then, so restating that rule here would be a second copy free to drift. */}
          <ServiceLocationMap
            addressLine1={value.address.address_line1}
            city={value.address.city}
            state={value.address.state}
            zip={value.address.zip}
          />
        </div>
      )}
    </div>
  );
}
