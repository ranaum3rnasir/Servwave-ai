import { request as playwrightRequest } from '@playwright/test';

const BASE_URL = 'http://localhost:5173';

interface AuthTokens {
  access_token: string;
}

/**
 * Log in as admin and return a fresh access token for API calls.
 */
export async function getAdminToken(): Promise<string> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const res = await ctx.post('/api/auth/login', {
    data: { email: 'admin@alphacrm.com', password: 'Admin123!@#' },
  });
  const body = await res.json() as { session?: AuthTokens };
  await ctx.dispose();
  return body.session?.access_token ?? '';
}

/**
 * Create a TECHNICIAN user. Returns the new user's id.
 */
const TECH_NAMES = [
  { first: 'Mike', last: 'Rodriguez' },
  { first: 'Jake', last: 'Thompson' },
  { first: 'Sam', last: 'Chen' },
  { first: 'Chris', last: 'Miller' },
  { first: 'Alex', last: 'Davis' },
];

export async function createTechnicianUser(
  token: string,
  suffix: string,
): Promise<string> {
  const idx = Math.abs(suffix.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % TECH_NAMES.length;
  const name = TECH_NAMES[idx];
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const res = await ctx.post('/api/users', {
    data: {
      email: `e2e-tech-${suffix}@test.local`,
      password: 'Test123!@#',
      first_name: name.first,
      last_name: name.last,
      role: 'TECHNICIAN',
    },
  });
  const body = await res.json() as { user: { id: string } };
  await ctx.dispose();
  return body.user.id;
}

/**
 * Delete a user by id.
 */
export async function deleteUser(token: string, userId: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await ctx.delete(`/api/users/${userId}`);
  await ctx.dispose();
}

/**
 * Create a no-estimate job via API (used purely as a schedulable-job fixture).
 * Returns jobId and jobNumber.
 *
 * Entity-redesign Phase D: the urgent flow is retired — createJob no longer accepts
 * is_urgent/urgency_reason. The name + signature are kept so the ~13 scheduling specs that
 * consume this as a fixture keep compiling; they just get a plain no-estimate job.
 */
export async function createUrgentJob(
  token: string,
  customerId: string,
  serviceLocationId: string,
): Promise<{ id: string; job_number: string }> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const res = await ctx.post('/api/jobs', {
    data: {
      customer_id: customerId,
      service_location_id: serviceLocationId,
    },
  });
  const body = await res.json() as { job: { id: string; job_number: string } };
  await ctx.dispose();
  return body.job;
}

/**
 * Assign a job to a technician with scheduled times via API.
 */
export async function assignJob(
  token: string,
  jobId: string,
  techId: string,
  scheduledStart: string,
  scheduledEnd: string,
  force = false,
): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await ctx.post(`/api/jobs/${jobId}/assign`, {
    data: {
      assignee_ids: [techId],
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      ...(force ? { force: true } : {}),
    },
  });
  await ctx.dispose();
}

/**
 * Get first customer + primary service location from the API.
 */
export async function getFirstCustomerWithLocation(
  token: string,
): Promise<{ customerId: string; locationId: string } | null> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  const res = await ctx.get('/api/customers?limit=1');
  const body = await res.json() as { customers: Array<{ id: string }> };
  if (!body.customers?.length) { await ctx.dispose(); return null; }
  const customerId = body.customers[0].id;

  const detailRes = await ctx.get(`/api/customers/${customerId}`);
  const detail = await detailRes.json() as {
    customer: { service_locations: Array<{ id: string; is_primary: boolean }> };
  };
  const locations = detail.customer.service_locations ?? [];
  const primary = locations.find(l => l.is_primary) ?? locations[0];
  await ctx.dispose();
  return primary ? { customerId, locationId: primary.id } : null;
}

/**
 * Start a job (transition to IN_PROGRESS).
 */
export async function startJob(token: string, jobId: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await ctx.post(`/api/jobs/${jobId}/start`);
  await ctx.dispose();
}

/**
 * Complete a job (transition to COMPLETED).
 */
export async function completeJob(token: string, jobId: string, notes?: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await ctx.post(`/api/jobs/${jobId}/complete`, {
    data: { completion_notes: notes || 'E2E audit completion' },
  });
  await ctx.dispose();
}

/**
 * Delete a job by id.
 */
export async function deleteJob(token: string, jobId: string): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
  });
  await ctx.delete(`/api/jobs/${jobId}`);
  await ctx.dispose();
}

/**
 * Create a lead via API with a new customer and service location.
 * Returns the lead id, lead_number, and customerId.
 */
export async function createLeadViaApi(
  token: string,
  data: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
    serviceRequest?: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
  } = {}
) {
  const suffix = Date.now().toString(36);
  const CUSTOMER_NAMES = [
    { first: 'James', last: 'Johnson' },
    { first: 'Maria', last: 'Martinez' },
    { first: 'Robert', last: 'Williams' },
    { first: 'Sarah', last: 'Chen' },
    { first: 'Michael', last: 'Thompson' },
  ];
  const cidx = Math.abs(suffix.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % CUSTOMER_NAMES.length;
  const cname = CUSTOMER_NAMES[cidx];
  // First create customer
  const customerRes = await fetch(`http://localhost:5173/api/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      first_name: data.firstName || cname.first,
      last_name: data.lastName || cname.last,
      email: data.email || `e2e-wt-${suffix}@test.local`,
      phone: data.phone || '5559876543',
    }),
  });
  const customer = await customerRes.json();
  const customerId = customer.customer?.id || customer.id;

  // Add service location
  await fetch(`http://localhost:5173/api/customers/${customerId}/locations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      address_line1: data.address || '456 Test Ave',
      city: data.city || 'Austin',
      state: data.state || 'TX',
      zip: data.zip || '78702',
      is_primary: true,
    }),
  });

  // Create lead
  const leadRes = await fetch(`http://localhost:5173/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      customer_id: customerId,
      service_request: data.serviceRequest || `E2E walkthrough test ${suffix}`,
      service_address_line1: data.address || '456 Test Ave',
      service_city: data.city || 'Austin',
      service_state: data.state || 'TX',
      service_zip: data.zip || '78702',
    }),
  });
  const leadData = await leadRes.json();
  return { id: leadData.lead.id, lead_number: leadData.lead.lead_number, customerId };
}

/**
 * Mark a lead as contacted via API.
 */
export async function markLeadContacted(
  token: string,
  leadId: string,
  contactedAt?: string,
  note?: string
) {
  const res = await fetch(`http://localhost:5173/api/leads/${leadId}/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contacted_at: contactedAt || new Date().toISOString(),
      contacted_note: note || 'E2E test contact',
    }),
  });
  const data = await res.json();
  if (!res.ok) console.error(`markLeadContacted failed (${res.status}):`, data?.error || data);
  return data;
}

/**
 * Schedule a walkthrough for a lead via API.
 */
export async function scheduleWalkthrough(
  token: string,
  leadId: string,
  assignedTo: string,
  scheduledAt?: string,
  durationMinutes?: number
) {
  const res = await fetch(`http://localhost:5173/api/leads/${leadId}/walkthrough/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      walkthrough_scheduled_at: scheduledAt || new Date(Date.now() + 86400000).toISOString(),
      performer_ids: [assignedTo],
      walkthrough_duration_minutes: durationMinutes || 60,
      send_email: false,
      force: true,
    }),
  });
  const data = await res.json();
  if (!res.ok) console.error(`scheduleWalkthrough failed (${res.status}):`, data?.error || data);
  return data;
}

/**
 * Complete a walkthrough for a lead via API.
 */
export async function completeWalkthrough(token: string, leadId: string) {
  const res = await fetch(`http://localhost:5173/api/leads/${leadId}/walkthrough/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (!res.ok) console.error(`completeWalkthrough failed (${res.status}):`, data?.error || data);
  return data;
}

/**
 * Cancel a walkthrough for a lead via API.
 */
export async function cancelWalkthrough(token: string, leadId: string, reason?: string) {
  const res = await fetch(`http://localhost:5173/api/leads/${leadId}/walkthrough/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ cancelled_reason: reason || 'E2E test cancellation' }),
  });
  return res.json();
}
