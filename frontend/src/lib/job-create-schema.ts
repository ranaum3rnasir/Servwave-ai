import { z } from 'zod';

// Create-job form schema (extracted from JobFormPage so it is unit-testable).
//
// Address fields are only required when the user is entering a NEW address —
// i.e. a new customer, or an existing customer with "+ Add new location".
// When an EXISTING service location is picked, its id is sent as
// `service_location_id` and the address inputs are hidden (and hold whatever the
// stored location contains, e.g. imported "New Jersey" states). Validating those
// hidden fields would silently block submit, so we skip them in that case.

const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

const createSchema = z.object({
  first_name: z.string().optional(),
  // Last name + company are optional; the customer needs a first name OR a company
  // name (unified-client-creation §2), and at least one of phone/email (SERV10X-35).
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  service_location_id: z.string().optional(),
  // Address fields are conditionally required (see superRefine). No object-level
  // `.max(2)` on state: an existing location legitimately holds a full state name
  // like "New Jersey", and that value is never sent when a location id is picked.
  service_address_line1: z.string().optional(),
  service_address_line2: z.string().optional(),
  service_city: z.string().optional(),
  service_state: z.string().optional(),
  service_zip: z.string().optional(),
  service_request: z.string().min(1, 'Service request is required'),
  job_type: z.string().optional(),
  ad_source: z.string().optional(),
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

  // Only validate the address when the user is entering a NEW one. When an
  // existing service location is picked we send `service_location_id` (the
  // address inputs are hidden), so requiring them would silently block submit.
  const pickedExisting = Boolean(d.service_location_id) && d.service_location_id !== '__add_new__';
  if (!pickedExisting) {
    if (!d.service_address_line1?.trim()) {
      ctx.addIssue({ code: 'custom', message: 'Address is required', path: ['service_address_line1'] });
    }
    if (!d.service_city?.trim()) {
      ctx.addIssue({ code: 'custom', message: 'City is required', path: ['service_city'] });
    }
    if ((d.service_state?.trim().length ?? 0) !== 2) {
      ctx.addIssue({ code: 'custom', message: 'State is required', path: ['service_state'] });
    }
    if ((d.service_zip?.trim().length ?? 0) < 5) {
      ctx.addIssue({ code: 'custom', message: 'ZIP is required', path: ['service_zip'] });
    }
  }
});

export const createJobFormSchema = createSchema;
export type CreateJobFormData = z.infer<typeof createSchema>;
