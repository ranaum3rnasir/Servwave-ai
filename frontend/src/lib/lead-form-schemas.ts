import { z } from 'zod';

// Create + edit lead form schemas (extracted from LeadFormPage so they are
// unit-testable).
//
// A lead does NOT require a service location (the backend's newCustomerSchema
// makes `location` optional and createLeadSchema has no "location required"
// rule). The address (new_location / new_customer.location) is only sent when
// the user actually types one. When an EXISTING location is picked its id is
// sent as `service_location_id` and the address inputs are hidden — holding
// whatever the stored location contains (e.g. imported "New Jersey" states).
// So the address fields carry NO object-level constraints (a stored value must
// never fail validation on a hidden field); requirements are enforced by
// refineAddress ONLY when the user is entering a NEW address.

type AddressFields = {
  service_location_id?: string | null;
  service_address_line1?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
};

function refineAddress(d: AddressFields, ctx: z.RefinementCtx) {
  const pickedExisting = Boolean(d.service_location_id) && d.service_location_id !== '__add_new__';
  const hasAddress = Boolean(d.service_address_line1?.trim());
  // A picked existing location is sent by id; an untouched address means "no
  // location" (valid for a lead). Only validate a NEW address the user is typing.
  if (pickedExisting || !hasAddress) return;
  if (!d.service_city?.trim()) {
    ctx.addIssue({ code: 'custom', message: 'City is required', path: ['service_city'] });
  }
  if ((d.service_state?.trim().length ?? 0) !== 2) {
    ctx.addIssue({ code: 'custom', message: 'Use a 2-letter state', path: ['service_state'] });
  }
  if ((d.service_zip?.trim().length ?? 0) < 5) {
    ctx.addIssue({ code: 'custom', message: 'ZIP is required', path: ['service_zip'] });
  }
}

const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

const createSchema = z.object({
  first_name: z.string().optional(),
  // First name OR company is required (unified-client-creation §2); at least one of
  // phone/email is required (SERV10X-35).
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  phone: z.string().optional(),
  // Optional extension for the primary phone (#530); persisted to customers.phone_ext.
  phone_ext: z.string().max(10).optional(),
  secondary_phone: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  // entity-redesign §3 — pick an existing ServiceLocation (precedence: id > new_location).
  service_location_id: z.string().optional(),
  service_address_line1: z.string().optional(),
  service_address_line2: z.string().optional(),
  service_city: z.string().optional(),
  service_state: z.string().optional(),
  service_zip: z.string().optional(),
  service_request: z.string().min(1, 'Service request is required'),
  notes: z.string().optional(),
  job_type: z.string().optional(),
  ad_source: z.string().optional(),
  assigned_to: z.string().optional(),
  scheduled_date: z.string().optional(),
  scheduled_time: z.string().optional(),
  scheduled_end_date: z.string().optional(),
  scheduled_end_time: z.string().optional(),
}).superRefine((d, ctx) => {
  if (!hasText(d.first_name) && !hasText(d.company_name)) {
    ctx.addIssue({ code: 'custom', message: 'Enter a first name or a company name', path: ['first_name'] });
  }
  const phone = d.phone?.trim() ?? '';
  const email = d.email?.trim() ?? '';
  if (!phone && !email) {
    ctx.addIssue({ code: 'custom', message: 'Enter a phone number or an email', path: ['phone'] });
  } else if (phone && phone.length < 7) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number', path: ['phone'] });
  }
  const secondary = d.secondary_phone?.trim() ?? '';
  if (secondary && secondary.length < 7) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid phone number', path: ['secondary_phone'] });
  }
  refineAddress(d, ctx);
});

const editSchema = z.object({
  service_request: z.string().min(1, 'Service request is required').max(2000),
  notes: z.string().max(5000).optional(),
  job_type: z.string().optional(),
  ad_source: z.string().optional(),
  scheduled_date: z.string().optional(),
  scheduled_time: z.string().optional(),
  scheduled_end_date: z.string().optional(),
  scheduled_end_time: z.string().optional(),
  // entity-redesign §3 — picked existing location or new-location sub-form inputs.
  service_location_id: z.string().optional(),
  service_address_line1: z.string().optional(),
  service_address_line2: z.string().optional(),
  service_city: z.string().optional(),
  service_state: z.string().optional(),
  service_zip: z.string().optional(),
}).superRefine(refineAddress);

export const createLeadFormSchema = createSchema;
export const editLeadFormSchema = editSchema;
export type CreateLeadFormData = z.infer<typeof createSchema>;
export type EditLeadFormData = z.infer<typeof editSchema>;
