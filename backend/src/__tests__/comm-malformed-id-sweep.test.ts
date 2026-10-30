import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader } from './helpers';

// Every id in these paths is a Postgres `uuid` column. A malformed `:id` on a communication route (a hand-typed URL, a truncated
// link, a client placeholder) reached Prisma's `where: { id }`, the driver threw P2023 and the handler's catch answered 500. The
// email, call, thread-read and chat routes already screen it (comm-email-malformed-id.test.ts); this covers the rest of the
// Communication routes that name a row by id. Each answers the same 404 its handler gives a row that is not there, after the
// permission guards (a person without the permission still gets the 403), and Prisma is never asked.
//
// Not listed on purpose: the training scenario read (a scenario is also found by its slug, so a non-uuid is a valid id there), the
// manual-log and email-conversation routes (their handlers screen the id themselves), and the call, email, thread-read and chat
// routes covered by comm-email-malformed-id.test.ts.

const MALFORMED = 'not-a-uuid';

type Route = { method: 'get' | 'post' | 'put' | 'patch' | 'delete'; path: string; body?: object; error: string };

const ROUTES: Route[] = [
  // Texts: one message's job and lead attribution, templates, text automations.
  { method: 'patch', path: `/sms/${MALFORMED}/job`, body: { job_id: null }, error: 'Message not found' },
  { method: 'patch', path: `/sms/${MALFORMED}/lead`, body: { lead_id: null }, error: 'Message not found' },
  { method: 'get', path: `/templates/${MALFORMED}`, error: 'Template not found' },
  { method: 'patch', path: `/templates/${MALFORMED}`, body: { name: 'x' }, error: 'Template not found' },
  { method: 'delete', path: `/templates/${MALFORMED}`, error: 'Template not found' },
  { method: 'get', path: `/automations/${MALFORMED}`, error: 'Automation not found' },
  { method: 'patch', path: `/automations/${MALFORMED}`, body: { name: 'x' }, error: 'Automation not found' },
  { method: 'delete', path: `/automations/${MALFORMED}`, error: 'Automation not found' },
  // Phone agents and the blocked list.
  { method: 'get', path: `/agents/${MALFORMED}`, error: 'Agent not found' },
  { method: 'get', path: `/blocked/${MALFORMED}`, error: 'Blocked number not found' },
  // Call flows, call groups and the training sessions.
  { method: 'get', path: `/call-flows/${MALFORMED}`, error: 'Call flow not found' },
  { method: 'patch', path: `/call-flows/${MALFORMED}`, body: { name: 'x' }, error: 'Call flow not found' },
  { method: 'delete', path: `/call-flows/${MALFORMED}`, error: 'Call flow not found' },
  { method: 'get', path: `/call-groups/${MALFORMED}`, error: 'Call group not found' },
  { method: 'patch', path: `/call-groups/${MALFORMED}`, body: { name: 'x' }, error: 'Call group not found' },
  { method: 'delete', path: `/call-groups/${MALFORMED}`, error: 'Call group not found' },
  { method: 'get', path: `/training/sessions/${MALFORMED}`, error: 'Training session not found' },
  // Company numbers and who may use them.
  { method: 'patch', path: `/numbers/${MALFORMED}`, body: { label: 'x' }, error: 'Number not found' },
  { method: 'delete', path: `/numbers/${MALFORMED}`, error: 'Number not found' },
  { method: 'put', path: `/numbers/${MALFORMED}/assignments`, body: { user_ids: [] }, error: 'Phone number not found' },
  { method: 'put', path: `/numbers/${MALFORMED}/org-default`, body: { is_org_default: true }, error: 'Phone number not found' },
  { method: 'put', path: `/users/${MALFORMED}/default-number`, body: { phone_number_id: null }, error: 'User not found' },
  // The customer behind a phone contact.
  { method: 'get', path: `/contacts/${MALFORMED}`, error: 'Customer not found' },
];

/** Every call any model of the mocked client has had that carries the malformed id anywhere in its arguments. */
function callsCarryingTheId(): string[] {
  const found: string[] = [];
  for (const [model, delegate] of Object.entries(prisma as unknown as Record<string, unknown>)) {
    if (typeof delegate !== 'object' || delegate === null) continue;
    for (const [action, fn] of Object.entries(delegate as Record<string, unknown>)) {
      const mock = (fn as { mock?: { calls: unknown[][] } }).mock;
      if (!mock) continue;
      for (const args of mock.calls) {
        if (JSON.stringify(args)?.includes(MALFORMED)) found.push(`${model}.${action}`);
      }
    }
  }
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
});

describe('communication :id routes - a malformed id is a 404, never a 500', () => {
  it.each(ROUTES)('$method $path answers 404 $error without asking the database', async ({ method, path, body, error }) => {
    // The phone setup and the calls tabs sit behind the pilot-or-demo org gate.
    mockAuthAs('admin', { is_demo: true });

    const res = await request(app)[method](`/api/communication${path}`).send(body ?? {}).set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe(error);
    expect(callsCarryingTheId()).toEqual([]);
  });

  it('keeps the permission answer first: a person without the permission is refused, not told the id is malformed', async () => {
    mockAuthAs('technician', { is_demo: true });

    const res = await request(app).delete(`/api/communication/automations/${MALFORMED}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
  });
});
