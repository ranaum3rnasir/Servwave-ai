// Pure builder for the POST /api/jobs request body. Mirrors the lead form's
// mutationFn body shape, mapping the form's "Service Request" → Job.scope_notes
// and routing Source to the customer (ad_source), never the job.
import { dayAndTimeToIso } from './schedule-tz';

export interface JobFormValues {
  // First name is optional — the customer needs a first name OR a company name
  // (unified-client-creation §2). Last name + company are also optional; at
  // least one of phone/email is required (SERV10X-35).
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone?: string;
  email?: string;
  service_location_id?: string;
  // Address fields are optional here because they are only required (and present)
  // on the new-customer / add-new-location paths; when an existing location is
  // picked we send service_location_id instead. See job-create-schema.ts.
  service_address_line1?: string;
  service_address_line2?: string;
  service_city?: string;
  service_state?: string;
  service_zip?: string;
  service_request: string;
  job_type?: string;
  ad_source?: string;
  scheduled_date?: string;
  scheduled_time?: string;
  scheduled_end_date?: string;
  scheduled_end_time?: string;
}

export interface BuildPayloadOpts {
  selectedCustomerId: string | null;
  showSchedule: boolean;
  /**
   * The ORG's IANA timezone (useScheduleTimezone()). Required, not optional: the schedule
   * fields above are zoneless wall-clock strings, so without it this builder resolves
   * "9:00 AM" against whatever timezone the dispatcher's laptop is in. That is exactly how
   * a Manila-booked 9am job came to be stored as 9pm New York.
   */
  timezone: string;
}

export function buildCreateJobPayload(data: JobFormValues, opts: BuildPayloadOpts): Record<string, unknown> {
  const base = {
    scope_notes: data.service_request,
    job_type: data.job_type || undefined,
    scheduled_start: opts.showSchedule
      ? dayAndTimeToIso(data.scheduled_date, data.scheduled_time, opts.timezone)
      : undefined,
    scheduled_end: opts.showSchedule
      ? dayAndTimeToIso(data.scheduled_end_date, data.scheduled_end_time, opts.timezone)
      : undefined,
  };

  const newLocation = {
    address_line1: data.service_address_line1,
    address_line2: data.service_address_line2 || undefined,
    city: data.service_city,
    state: data.service_state,
    zip: data.service_zip,
  };

  if (opts.selectedCustomerId) {
    const pickedExisting = Boolean(data.service_location_id) && data.service_location_id !== '__add_new__';
    return {
      customer_id: opts.selectedCustomerId,
      ad_source: data.ad_source || undefined,
      // Workiz-style accretion (spec §5.3): a typed phone/email on a linked existing
      // customer is added as a new secondary — never sent on the new_customer path below.
      phone: data.phone || undefined,
      email: data.email || undefined,
      ...base,
      ...(pickedExisting ? { service_location_id: data.service_location_id } : { new_location: newLocation }),
    };
  }

  return {
    new_customer: {
      first_name: data.first_name,
      last_name: data.last_name || undefined,
      company_name: data.company_name || undefined,
      phone: data.phone || undefined,
      email: data.email || undefined,
      ad_source: data.ad_source || undefined,
      location: {
        address_line1: data.service_address_line1,
        address_line2: data.service_address_line2 || undefined,
        city: data.service_city,
        state: data.service_state,
        zip: data.service_zip,
      },
    },
    ...base,
  };
}
