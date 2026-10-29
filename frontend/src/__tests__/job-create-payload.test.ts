import { describe, it, expect } from 'vitest';
import { buildCreateJobPayload, type JobFormValues } from '@/lib/job-create-payload';

function baseValues(overrides: Partial<JobFormValues> = {}): JobFormValues {
  return {
    first_name: 'Bob',
    phone: '5551234567',
    service_location_id: 'loc-1',
    service_request: 'Fix the AC',
    ...overrides,
  };
}

describe('buildCreateJobPayload — existing-customer accretion (unified-client-creation §5.3)', () => {
  it('sends the typed phone/email alongside customer_id when linked to an existing customer', () => {
    const payload = buildCreateJobPayload(
      baseValues({ phone: '5559998888', email: 'new@example.com' }),
      { selectedCustomerId: 'cust-1', showSchedule: false, timezone: 'America/New_York' },
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      customer_id: 'cust-1',
      phone: '5559998888',
      email: 'new@example.com',
    });
  });

  it('omits phone/email from the payload when blank', () => {
    const payload = buildCreateJobPayload(
      baseValues({ phone: '', email: '' }),
      { selectedCustomerId: 'cust-1', showSchedule: false, timezone: 'America/New_York' },
    ) as Record<string, unknown>;
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
  });

  it('does not send a top-level phone/email on the new_customer path (they live inside new_customer)', () => {
    const payload = buildCreateJobPayload(
      baseValues({
        phone: '5551234567', email: 'bob@example.com',
        service_address_line1: '1 Main St', service_city: 'Austin', service_state: 'TX', service_zip: '78701',
      }),
      { selectedCustomerId: null, showSchedule: false, timezone: 'America/New_York' },
    ) as Record<string, unknown>;
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect((payload.new_customer as Record<string, unknown>).phone).toBe('5551234567');
  });
});
