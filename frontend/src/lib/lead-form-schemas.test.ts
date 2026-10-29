import { describe, it, expect } from 'vitest';
import { createLeadFormSchema, editLeadFormSchema } from './lead-form-schemas';

// The reported bug: selecting an existing customer copies that customer's stored
// service location into hidden fields (state = imported "New Jersey"). Because
// the location id is what actually gets sent, validation must NOT block on it —
// otherwise form.handleSubmit silently aborts and the button looks dead.

const createBase = {
  first_name: 'Jane',
  last_name: 'Doe',
  company_name: '',
  phone: '(555) 123-4567',
  email: '',
  service_location_id: '',
  service_address_line1: '',
  service_address_line2: '',
  service_city: '',
  service_state: '',
  service_zip: '',
  service_request: 'Fix the front door lock',
  notes: '',
  job_type: '',
  ad_source: '',
  assigned_to: '',
  scheduled_date: '',
  scheduled_time: '',
  scheduled_end_date: '',
  scheduled_end_time: '',
};

describe('createLeadFormSchema', () => {
  it('accepts an existing customer + picked location whose stored state is not schema-clean ("New Jersey")', () => {
    const result = createLeadFormSchema.safeParse({
      ...createBase,
      service_location_id: 'l0000000-0000-0000-0000-0000000000bb',
      service_address_line1: '12 Elm St',
      service_city: 'Ridgefield',
      service_state: 'New Jersey',
      service_zip: '076',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a NEW customer with no address at all (leads do not require a location)', () => {
    expect(createLeadFormSchema.safeParse(createBase).success).toBe(true);
  });

  it('requires a well-formed 2-letter state when the user types a NEW address', () => {
    const result = createLeadFormSchema.safeParse({
      ...createBase,
      service_location_id: '',
      service_address_line1: '12 Elm St',
      service_city: 'Newark',
      service_state: 'New Jersey', // must be a 2-letter code when entering a new address
      service_zip: '07102',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('service_state');
    }
  });

  it('requires city + zip when the user types a NEW address', () => {
    const result = createLeadFormSchema.safeParse({
      ...createBase,
      service_location_id: '',
      service_address_line1: '12 Elm St',
      service_city: '',
      service_state: 'NJ',
      service_zip: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('service_city');
      expect(paths).toContain('service_zip');
    }
  });

  it('still requires either a phone or an email', () => {
    const result = createLeadFormSchema.safeParse({ ...createBase, phone: '', email: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('phone');
    }
  });

  it('still requires a service request', () => {
    expect(createLeadFormSchema.safeParse({ ...createBase, service_request: '' }).success).toBe(false);
  });
});

describe('editLeadFormSchema', () => {
  const editBase = {
    service_request: 'Fix the front door lock',
    notes: '',
    job_type: '',
    ad_source: '',
    scheduled_date: '',
    scheduled_time: '',
    scheduled_end_date: '',
    scheduled_end_time: '',
    service_location_id: '',
    service_address_line1: '',
    service_address_line2: '',
    service_city: '',
    service_state: '',
    service_zip: '',
  };

  it('accepts editing a lead whose picked existing location has a non-2-char stored state ("New Jersey")', () => {
    const result = editLeadFormSchema.safeParse({
      ...editBase,
      service_location_id: 'l0000000-0000-0000-0000-0000000000bb',
      service_address_line1: '12 Elm St',
      service_city: 'Ridgefield',
      service_state: 'New Jersey',
      service_zip: '076',
    });
    expect(result.success).toBe(true);
  });

  it('requires a well-formed 2-letter state when switching to a NEW location', () => {
    const result = editLeadFormSchema.safeParse({
      ...editBase,
      service_location_id: '__add_new__',
      service_address_line1: '9 Oak Ave',
      service_city: 'Newark',
      service_state: 'New Jersey',
      service_zip: '07102',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toContain('service_state');
    }
  });
});
