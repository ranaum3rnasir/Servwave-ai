import type { ReactNode } from 'react';

import { AddressAutocomplete } from '@/components/crm/address-autocomplete';
import {
  ADD_NEW_LOCATION, formatLocationLabel,
  type NewAddressField, type PickOrAccreteLocationValue, type ServiceLocationOption,
} from '@/components/crm/PickOrAccreteLocation';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SelectField } from '@/ui-kit/components/form/selectField';

/**
 * v2 pick-or-accrete-location control - the kit rebuild of
 * `components/crm/PickOrAccreteLocation`.
 *
 * The `__add_new__` sentinel, the value shape and the `pal-*` DOM ids are
 * imported/kept verbatim: the parent still translates the value into
 * `{ service_location_id }` vs `{ new_location }`, and e2e selectors target
 * those ids.
 *
 * `AddressAutocomplete` is the app's Google Places control, reused rather than
 * rebuilt: rebuilding it would fork the Places integration, which is business
 * logic, not presentation. Recorded in the branch report.
 */
export interface PickLocationProps {
  locations: ServiceLocationOption[];
  value: PickOrAccreteLocationValue;
  onChange: (value: PickOrAccreteLocationValue) => void;
  label?: string;
  required?: boolean;
  showPicker?: boolean;
  pickerNote?: ReactNode;
  errors?: Partial<Record<NewAddressField, string | undefined>>;
  idPrefix?: string;
}

export function PickLocation({
  locations,
  value,
  onChange,
  label = 'Location',
  required = false,
  showPicker = true,
  pickerNote,
  errors,
  idPrefix = 'pal',
}: PickLocationProps) {
  const { locationId, address } = value;
  const addingNew = locationId === ADD_NEW_LOCATION;

  const setAddressField = (field: NewAddressField, val: string) => {
    onChange({ ...value, address: { ...address, [field]: val } });
  };

  const handlePick = (val: string) => {
    if (val === ADD_NEW_LOCATION) {
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

  return (
    <>
      {showPicker && (
        <div className="flex flex-col gap-1.5">
          <Label>{label}{required ? ' *' : ''}</Label>
          <SelectField
            value={locationId || ''}
            onValueChange={handlePick}
            placeholder="Select a service location"
            options={[
              ...locations.map((loc) => ({ value: loc.id, label: formatLocationLabel(loc) })),
              { value: ADD_NEW_LOCATION, label: '+ Add new location' },
            ]}
          />
          {pickerNote}
        </div>
      )}

      {(addingNew || !showPicker) && (
        <>
          <div className="grid grid-cols-[1fr_80px] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-address-line1`}>Address{required ? ' *' : ''}</Label>
              <AddressAutocomplete
                id={`${idPrefix}-address-line1`}
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
              {errors?.address_line1 && <p className="text-destructive text-xs">{errors.address_line1}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-address-line2`}>Unit</Label>
              <Input
                id={`${idPrefix}-address-line2`}
                value={address.address_line2 || ''}
                onChange={(e) => setAddressField('address_line2', e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-city`}>City{required ? ' *' : ''}</Label>
              <Input
                id={`${idPrefix}-city`}
                value={address.city || ''}
                onChange={(e) => setAddressField('city', e.target.value)}
              />
              {errors?.city && <p className="text-destructive text-xs">{errors.city}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-state`}>State{required ? ' *' : ''}</Label>
              <Input
                id={`${idPrefix}-state`}
                maxLength={2}
                value={address.state || ''}
                onChange={(e) => setAddressField('state', e.target.value)}
              />
              {errors?.state && <p className="text-destructive text-xs">{errors.state}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${idPrefix}-zip`}>ZIP{required ? ' *' : ''}</Label>
              <Input
                id={`${idPrefix}-zip`}
                value={address.zip || ''}
                onChange={(e) => setAddressField('zip', e.target.value)}
              />
              {errors?.zip && <p className="text-destructive text-xs">{errors.zip}</p>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
