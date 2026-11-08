import api from '@/lib/axios';
import { ADD_NEW_LOCATION, type PickOrAccreteLocationValue } from '@/components/crm/PickOrAccreteLocation';

/**
 * Resolve the plan's service_location_id. If the user authored a NEW address,
 * persist it first (the service-plan endpoint only accepts an existing id) and
 * return the new location's id; otherwise pass the chosen id through.
 *
 * Deliberately pure: it POSTs and returns the id, but never touches state. The CALLER
 * must pin the returned id back into its location value (see `submit`), because this
 * POST is not idempotent - re-running it for the same address orphans a duplicate.
 */
export async function resolveServiceLocationId(
  customerId: string,
  locValue: PickOrAccreteLocationValue,
  hadZeroLocations: boolean,
): Promise<string> {
  if (locValue.locationId !== ADD_NEW_LOCATION) return locValue.locationId;
  const a = locValue.address;
  const { data } = await api.post(`/api/customers/${customerId}/locations`, {
    address_line1: a.address_line1.trim(),
    ...(a.address_line2.trim() ? { address_line2: a.address_line2.trim() } : {}),
    city: a.city.trim(), state: a.state.trim(), zip: a.zip.trim(),
    is_primary: hadZeroLocations,
  });
  return data.location.id as string;
}
