import { describe, it, expect } from 'vitest';
import { buildCreateJobPayload, type JobFormValues } from './job-create-payload';

const base: JobFormValues = {
  first_name: 'Jane', last_name: 'Doe', company_name: '', phone: '5551234567', email: 'jane@x.com',
  service_location_id: '', service_address_line1: '1 Main', service_address_line2: '',
  service_city: 'Austin', service_state: 'TX', service_zip: '78701',
  service_request: 'Fix AC', job_type: 'HVAC Service', ad_source: 'Referral',
  scheduled_date: '', scheduled_time: '', scheduled_end_date: '', scheduled_end_time: '',
};

describe('buildCreateJobPayload', () => {
  it('existing customer + picked location → customer_id + service_location_id, scope_notes from service_request, ad_source top-level', () => {
    const p = buildCreateJobPayload({ ...base, service_location_id: 'loc-1' }, { selectedCustomerId: 'cust-1', showSchedule: false, timezone: 'America/New_York' });
    expect(p).toMatchObject({
      customer_id: 'cust-1',
      service_location_id: 'loc-1',
      scope_notes: 'Fix AC',
      job_type: 'HVAC Service',
      ad_source: 'Referral',
    });
    expect(p.new_customer).toBeUndefined();
    expect(p.new_location).toBeUndefined();
  });

  it('existing customer + "__add_new__" → new_location instead of service_location_id', () => {
    const p = buildCreateJobPayload({ ...base, service_location_id: '__add_new__' }, { selectedCustomerId: 'cust-1', showSchedule: false, timezone: 'America/New_York' });
    expect(p.service_location_id).toBeUndefined();
    expect(p.new_location).toEqual({ address_line1: '1 Main', address_line2: undefined, city: 'Austin', state: 'TX', zip: '78701' });
  });

  it('new customer → new_customer with nested location + ad_source, no customer_id', () => {
    const p = buildCreateJobPayload(base, { selectedCustomerId: null, showSchedule: false, timezone: 'America/New_York' });
    expect(p.customer_id).toBeUndefined();
    expect(p.new_customer).toMatchObject({
      first_name: 'Jane', last_name: 'Doe', phone: '5551234567', email: 'jane@x.com', ad_source: 'Referral',
      location: { address_line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' },
    });
    expect(p.scope_notes).toBe('Fix AC');
  });

  it('omits schedule fields when showSchedule is false and includes them when true', () => {
    const off = buildCreateJobPayload(base, { selectedCustomerId: 'cust-1', showSchedule: false, timezone: 'America/New_York' });
    expect(off.scheduled_start).toBeUndefined();

    const on = buildCreateJobPayload(
      { ...base, service_location_id: 'loc-1', scheduled_date: '2026-07-01', scheduled_time: '09:00' },
      { selectedCustomerId: 'cust-1', showSchedule: true, timezone: 'America/New_York' },
    );
    expect(typeof on.scheduled_start).toBe('string');
  });
});
