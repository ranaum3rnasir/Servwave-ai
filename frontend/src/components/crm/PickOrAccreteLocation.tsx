import { useMemo } from 'react';
import { SelectField, type SelectFieldAction } from '@/components/form/SelectField';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/patterns/FormField';
import { AddressAutocomplete } from '@/components/crm/address-autocomplete';

// ─── Public types ─────────────────────────────────────
//
// A reusable pick-or-accrete-location control extracted from the lead form
// (standalone-invoices plan §5.1). For a chosen customer it lets the user pick
// one of their existing ServiceLocations OR add a new address (the lead form's
// '__add_new__' → new_location pattern). It is fully CONTROLLED: the parent owns
// the selected-location id and the new-address fields, so it maps cleanly onto a
// `service_location_id` + address sub-form whether that lives in RHF or local
// state. The parent translates the value into the API shape
// (`{ service_location_id }` vs `{ new_location }`).

/** Sentinel `locationId` value meaning "author a new address". */
export const ADD_NEW_LOCATION = '__add_new__';

export interface ServiceLocationOption {
  id: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  zip: string;
  is_primary: boolean;
}

/** The new-address sub-form fields (used when `locationId === ADD_NEW_LOCATION`). */
export interface NewAddressFields {
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
}

export type NewAddressField = keyof NewAddressFields;

export interface PickOrAccreteLocationValue {
  /** A ServiceLocation id, '' (none chosen), or `ADD_NEW_LOCATION`. */
  locationId: string;
  /** New-address fields — only meaningful when `locationId === ADD_NEW_LOCATION`. */
  address: NewAddressFields;
}

export interface PickOrAccreteLocationProps {
  /** The customer's existing service locations (scope). Empty for a zero-location customer. */
  locations: ServiceLocationOption[];
  value: PickOrAccreteLocationValue;
  onChange: (value: PickOrAccreteLocationValue) => void;

  /** Field label (lead form uses "Location *" / "Location"). */
  label?: string;
  /** Mark the picker required (adds an asterisk to the label). */
  required?: boolean;
  /** Whether to show the picker `Select` at all (false → only the new-address form). */
  showPicker?: boolean;
  /** Optional note rendered under the picker (e.g. the tax-change warning). */
  pickerNote?: React.ReactNode;
  /** Per-field validation messages for the new-address sub-form. */
  errors?: Partial<Record<NewAddressField, string | undefined>>;
  /**
   * Prefix for the new-address sub-form's DOM ids (`{idPrefix}-address-line1`, etc.).
   * Defaults to `'pal'`. Pass a distinct value when a page can render more than one
   * `PickOrAccreteLocation` instance at once, so `getByLabelText`/`htmlFor` targeting
   * stays unambiguous and ids never collide.
   */
  idPrefix?: string;
}

export function formatLocationLabel(loc: ServiceLocationOption): string {
  const line = [loc.address_line1, loc.address_line2].filter(Boolean).join(', ');
  return `${line} — ${loc.city}, ${loc.state} ${loc.zip}`;
}

// ─── Component ────────────────────────────────────────

export function PickOrAccreteLocation({
  locations,
  value,
  onChange,
  label = 'Location',
  required = false,
  showPicker = true,
  pickerNote,
  errors,
  idPrefix = 'pal',
}: PickOrAccreteLocationProps) {
  const { locationId, address } = value;
  const addingNew = locationId === ADD_NEW_LOCATION;

  const locationOptions = useMemo(
    () => locations.map((loc) => ({ value: loc.id, label: formatLocationLabel(loc) })),
    [locations]
  );

  const setAddressField = (field: NewAddressField, val: string) => {
    onChange({ ...value, address: { ...address, [field]: val } });
  };

  const handlePick = (val: string) => {
    if (val === ADD_NEW_LOCATION) {
      // Reveal the sub-form with cleared fields for the new entry.
      onChange({
        locationId: ADD_NEW_LOCATION,
        address: { address_line1: '', address_line2: '', city: '', state: '', zip: '' },
      });
      return;
    }
    const loc = locations.find((l) => l.id === val);
    onChange({
      locationId: val,
      address: loc
        ? {
            address_line1: loc.address_line1,
            address_line2: loc.address_line2 || '',
            city: loc.city,
            state: loc.state,
            zip: loc.zip,
          }
        : address,
    });
  };

  // "+ Add new location" is not a location: it reveals the address sub-form.
  // Routed through handlePick so the sentinel branch stays the one definition
  // of what adding means.
  const addNewLocationAction: SelectFieldAction = {
    label: '+ Add new location',
    onSelect: () => handlePick(ADD_NEW_LOCATION),
  };

  return (
    <>
      {showPicker && (
        <div>
          {/* Render prop, not a cloned child: `Select` is Radix's context root and
              renders no DOM of its own, so the generated id has to land on the
              trigger (a labelable <button>) for the label to point at anything. */}
          <FormField label={label} required={required}>
            {(fieldProps) => (
              <SelectField
                {...fieldProps}
                value={locationId || ''}
                onValueChange={handlePick}
                placeholder="Select a service location"
                options={locationOptions}
                action={addNewLocationAction}
              />
            )}
          </FormField>
          {/* Stays outside the FormField rather than becoming its `hint`: call
              sites pass a whole <p> here (StandaloneInvoiceFormPage's tax note),
              and `hint` renders its own <p> - nesting one in the other is
              invalid HTML the browser would silently reparent. */}
          {pickerNote}
        </div>
      )}

      {/* New-address sub-form. */}
      {(addingNew || !showPicker) && (
        <>
          <div className="grid grid-cols-[1fr_80px] gap-3">
            <FormField
              label="Address"
              htmlFor={`${idPrefix}-address-line1`}
              required={required}
              error={errors?.address_line1}
            >
              <AddressAutocomplete
                value={address.address_line1 || ''}
                onChange={(val) => setAddressField('address_line1', val)}
                onSelect={(place) => {
                  onChange({
                    ...value,
                    address: {
                      ...address,
                      address_line1: place.address_line1,
                      city: place.city,
                      state: place.state,
                      zip: place.zip,
                    },
                  });
                }}
              />
            </FormField>
            <FormField label="Unit" htmlFor={`${idPrefix}-address-line2`}>
              <Input value={address.address_line2 || ''} onChange={(e) => setAddressField('address_line2', e.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <FormField label="City" htmlFor={`${idPrefix}-city`} required={required} error={errors?.city}>
              <Input value={address.city || ''} onChange={(e) => setAddressField('city', e.target.value)} />
            </FormField>
            <FormField label="State" htmlFor={`${idPrefix}-state`} required={required} error={errors?.state}>
              <Input maxLength={2} value={address.state || ''} onChange={(e) => setAddressField('state', e.target.value)} />
            </FormField>
            <FormField label="ZIP" htmlFor={`${idPrefix}-zip`} required={required} error={errors?.zip}>
              <Input value={address.zip || ''} onChange={(e) => setAddressField('zip', e.target.value)} />
            </FormField>
          </div>
        </>
      )}
    </>
  );
}
