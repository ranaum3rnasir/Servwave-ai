/**
 * Roles & Permissions, PRD 8, S08.17 - Access Communication closes EVERY section list and phone tab endpoint on the
 * server, and never a record tab.
 *
 * comm-section-gate.test.ts proves the gate with one route per file. This file proves it for all of them, from the
 * route files themselves, so a section endpoint added later without the gate fails here instead of going unnoticed:
 *
 *   1. Every route in the communication route files either carries the section gate or is named below, with the reason
 *      it does not (a record tab's own surface, the dialer, composing, a by-id read, a setting only an admin changes).
 *   2. Every gated route answers 403 for a person whose Access Communication is off, and does not for a person who has it.
 *   3. The three record tabs (lead, job, customer) and what opens from them still answer with it off.
 *
 * The person is a custom-role shape (a base role with the switch turned off), never a built-in role name's behaviour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, authHeader, LEAD_FIXTURE, JOB_FIXTURE, CUSTOMER_FIXTURE, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const ROUTES_DIR = join(__dirname, '..', 'routes');
const SOME_ID = 'a1b2c3d4-0000-0000-0000-000000000001';

interface RouteLine { file: string; method: string; path: string; gated: boolean }

/** Every `router.<method>('<path>', ...)` statement in the communication route files, and whether it carries the section gate. */
function communicationRoutes(): RouteLine[] {
  const out: RouteLine[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => /^comm-.*\.routes\.ts$/.test(f)).sort()) {
    // Comments name the gate too; only the code counts.
    const code = readFileSync(join(ROUTES_DIR, file), 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    for (const statement of code.split(/\n(?=router\.)/)) {
      const head = /^router\.(get|post|put|patch|delete)\(\s*'([^']+)'/.exec(statement);
      if (!head) continue;
      out.push({
        file,
        method: head[1]!,
        path: head[2]!,
        gated: statement.includes("canDo('access_inbox', 'Communication')"),
      });
    }
  }
  return out;
}

/** The routes that do NOT carry the section gate, and why. A new route must either carry it or be added here on purpose. */
const OUTSIDE_THE_SECTION: Record<string, string> = {
  // A record tab's own surface: what opens from a job, lead or customer tab, filtered by what the person may open.
  'get /calls/:id': 'a call opened from a record tab',
  'get /calls/:id/recording': 'the call drawer, with Play recording',
  'get /calls/:id/recording/download': 'the call drawer, with Download recording',
  'get /calls/:id/transcript': 'the call drawer, with View transcript',
  'patch /calls/:id/job': 'attaching a call, with Attach conversations',
  'patch /calls/:id/lead': 'attaching a call, with Attach conversations',
  'get /threads/:id': 'a conversation opened from a record tab',
  'patch /threads/:id/read': 'reading a conversation opened from a record tab',
  'patch /threads/:id/unread': 'reading a conversation opened from a record tab',
  'patch /sms/:id/job': 'attaching a text, with Attach conversations',
  'patch /sms/:id/lead': 'attaching a text, with Attach conversations',
  'patch /emails/:id/job': 'attaching an email, with Attach conversations',
  'patch /emails/:id/lead': 'attaching an email, with Attach conversations',
  'get /emails/attach-source': 'the email composer on a record',
  'get /sending-identity': 'the email composer on a record',
  'get /templates': 'the composer, which reads templates for the signature',
  // Composing and calling, which are not a way into the section lists.
  'post /sms': 'sending a text (the new-conversation case checks the gate inside)',
  'post /emails': 'sending an email (a send from a record tab needs no section; a reply, and a send from the Email page, check the gate inside)',
  'post /calls': 'placing a call',
  'post /calls/attribution': 'placing a call from the browser phone',
  'get /calls/outcome': 'the dialer asking how a call it placed ended',
  'get /dialer-search': 'the dialer',
  'get /contacts': 'the dialer and the customer pickers, behind View customers',
  'get /contacts/:id': 'the dialer and the customer pickers, behind View customers',
  'get /my-outbound-number': 'the dialer',
  'get /my-numbers': 'the dialer',
  'post /phone-access': 'the browser phone token, behind Office phone in the browser',
  // The manual log has its own switch (Log past communications) and is a record surface.
  'post /manual-log': 'the manual log, behind Log past communications',
  'get /manual-log/performers': 'the manual log picker, behind Log past communications',
  'get /manual-log/:id': 'the manual log, behind Log past communications',
  'put /manual-log/:id': 'the manual log, behind Log past communications',
  'delete /manual-log/:id': 'the manual log, behind Log past communications',
  // Settings only an administrator changes.
  'get /number-assignments': 'administrator settings',
  'put /numbers/:id/assignments': 'administrator settings',
  'put /numbers/:id/org-default': 'administrator settings',
  'put /users/:userId/default-number': 'administrator settings',
  'post /numbers/search': 'buying a number, behind Company settings',
  'post /numbers/buy': 'buying a number, behind Company settings',
  'post /numbers/register-byo': 'registering a number, behind Company settings',
  'post /numbers/refresh': 'refreshing numbers, behind Company settings',
  'delete /numbers/:id': 'releasing a number, behind Company settings',
};

/**
 * A person holding every toggle switch, Access Communication as given: the section gate is then the only thing that
 * can refuse a route, so a 403 with it off is the gate and nothing else.
 */
function everythingOnExceptSection(accessCommunication: boolean): Record<string, boolean> {
  const values = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, true]));
  return { ...values, access_communication: accessCommunication };
}

const routes = communicationRoutes();
const keyOf = (r: RouteLine) => `${r.method} ${r.path}`;
const gatedRoutes = routes.filter((r) => r.gated);
const concretePath = (path: string) => `/api/communication${path.replace(/:[A-Za-z]+/g, SOME_ID)}`;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.message.count = vi.fn().mockResolvedValue(0);
  mockPrisma.whatsAppChat.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.email.count.mockResolvedValue(0);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.phoneAgent.findMany.mockResolvedValue([]);
  mockPrisma.phoneNumber.findMany.mockResolvedValue([]);
  mockPrisma.callFlow.findMany.mockResolvedValue([]);
  mockPrisma.textTemplate.findMany.mockResolvedValue([]);
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York', comm_usage_uncapped: false });
});

describe('the communication route files', () => {
  it('are read (the table below is not empty)', () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(gatedRoutes.length).toBeGreaterThan(30);
  });

  it('carry the section gate on every route that is not named as outside the section, and name no route that has it', () => {
    const ungated = routes.filter((r) => !r.gated).map(keyOf).sort();
    expect(ungated).toEqual(Object.keys(OUTSIDE_THE_SECTION).sort());
  });

  it('cover the section lists and the phone tabs the PRD names', () => {
    const gated = gatedRoutes.map(keyOf);
    for (const route of [
      'get /calls', 'get /threads', 'get /emails', 'get /unread-counts', 'get /agents', 'get /blocked',
      'get /call-flows', 'get /call-groups', 'get /training/scenarios', 'get /training/sessions',
      'get /numbers', 'get /usage',
    ]) {
      expect(gated, route).toContain(route);
    }
  });
});

describe('every section list and phone tab endpoint, with Access Communication off and on', () => {
  for (const route of gatedRoutes) {
    const label = `${route.method.toUpperCase()} ${route.path}`;
    const demoOnly = route.file === 'comm-whatsapp.routes.ts';

    it(`${label}: refused with Access Communication off`, async () => {
      mockAuthAs('dispatcher', demoOnly ? { is_demo: true } : {});
      mockRoleSwitches(everythingOnExceptSection(false));
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[route.method]!(concretePath(route.path))
        .set(authHeader('dispatcher'))
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Insufficient permissions' });
    });

    it(`${label}: not refused with Access Communication on`, async () => {
      mockAuthAs('dispatcher', demoOnly ? { is_demo: true } : {});
      mockRoleSwitches(everythingOnExceptSection(true));
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[route.method]!(concretePath(route.path))
        .set(authHeader('dispatcher'))
        .send({});
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });
  }
});

describe('the record tabs never need Access Communication', () => {
  it('answer for a person with it off: the lead, job and customer tabs', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ access_communication: false });
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_FIXTURE.id });
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_FIXTURE.id, lead_assignees: [{ user_id: TEST_USERS.sales.id }] });
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id, created_by_id: TEST_USERS.sales.id });

    // The section is closed to this person: a list answers 403 ...
    expect((await request(app).get('/api/communication/calls').set(authHeader('sales'))).status).toBe(403);
    // ... and the tabs on their records still answer.
    expect((await request(app).get(`/api/leads/${LEAD_FIXTURE.id}/communications`).set(authHeader('sales'))).status).toBe(200);
    expect((await request(app).get(`/api/jobs/${JOB_FIXTURE.id}/communications`).set(authHeader('sales'))).status).toBe(200);
    expect((await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}/communications`).set(authHeader('sales'))).status).toBe(200);
  });
});
