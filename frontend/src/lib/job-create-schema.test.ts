import { describe, it, expect } from 'vitest';
import { createJobFormSchema } from './job-create-schema';

// A form snapshot that mirrors what JobFormPage holds after the user has filled
// in the required visible fields. Address fields are populated as they would be
// after selecting an existing customer (from the stored service location).
const base = {
  first_name: 'Jane',
  last_name: 'Doe',
  company_name: '',
  phone: '(555) 123-4567',
  email: 'jane@example.com',
  service_location_id: '',
  service_address_line1: '1 Main St',
  service_address_line2: '',
  service_city: 'Austin',
  service_state: 'TX',
  service_zip: '78701',
  service_request: 'Fix the front door lock',
  job_type: '',
  ad_source: '',
  scheduled_date: '',
  scheduled_time: '',
  scheduled_end_date: '',
  scheduled_end_time: '',
};

describe('createJobFormSchema', () => {
  it('accepts an existing customer + picked location even when the stored address is not schema-clean (imported "New Jersey" state, empty zip/city)', () => {
    // This is the reported bug: selecting an existing Alpha Doors customer copies
    // the imported location into hidden fields (state="New Jersey"). Because the
    // location id is what actually gets sent, validation must NOT block on it.
    const result = createJobFormSchema.safeParse({
      ...base,
      service_location_id: 'loc-uuid-1',
      service_state: 'New Jersey',
      service_zip: '',
      service_city: '',
      service_address_line1: 'nj',
    });
    expect(result.success).toBe(true);
  });

  it('requires a full, well-formed address for a NEW customer (no location picked)', () => {
    const result = createJobFormSchema.safeParse({
      ...base,
      service_location_id: '',
      service_address_line1: '',
      service_city: '',
      service_state: '',
      service_zip: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('service_address_line1');
      expect(paths).toContain('service_city');
      expect(paths).toContain('service_state');
      expect(paths).toContain('service_zip');
    }
  });

  it('requires a well-formed address when an existing customer adds a NEW location', () => {
    const result = createJobFormSchema.safeParse({
      ...base,
      service_location_id: '__add_new__',
      service_state: 'New Jersey', // user must enter a clean 2-char state here
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('service_state');
    }
  });

  it('accepts a clean full address for a new customer', () => {
    expect(createJobFormSchema.safeParse(base).success).toBe(true);
  });

  it('still requires either a phone or an email', () => {
    const result = createJobFormSchema.safeParse({ ...base, phone: '', email: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('phone');
    }
  });

  it('still requires a service request', () => {
    const result = createJobFormSchema.safeParse({ ...base, service_request: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('service_request');
    }
  });
});
