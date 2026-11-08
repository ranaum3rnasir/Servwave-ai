/**
 * workflows.test.ts — /api/workflows REST API (multi-step Workflow Builder).
 *
 * Mirrors automations.test.ts: RBAC (admin/dispatcher allowed, sales/technician
 * 403), tenant scoping (pinned via mock.calls), the two validation tiers (draft
 * tier lets incomplete steps through, publish tier gates on validateWorkflow
 * Definition), plus dry-run and the legacy+new activity union. Prisma fully
 * mocked via setup.ts; requests hit the real Express app.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../services/automations/mergeFieldFallbacks';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';

vi.mock('../lib/audit', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));
import { logAudit } from '../lib/audit';

import { sendAutomationEmail } from '../lib/email';
import { UNSUPPORTED_STEP_MESSAGE, retiredInAppStepMessage } from '../services/automations/workflowValidation';

const mockPrisma = prisma as any;
const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockAudit = logAudit as ReturnType<typeof vi.fn>;
const mockSendEmail = sendAutomationEmail as ReturnType<typeof vi.fn>;

const WF_ID = 'b0000000-0000-0000-0000-0000000000bb';

const BASE_WORKFLOW = {
  id: WF_ID,
  name: 'Reminder flow',
  status: 'DRAFT',
  is_enabled: false,
  trigger_type: 'JOB_SCHEDULED',
  trigger_config: null,
  send_window: 'ANYTIME',
  template_key: null,
  legacy_rule_id: null,
  published_version_id: null,
  published_at: null,
  last_triggered_at: null,
  trigger_count: 0,
  created_by_id: TEST_USERS.admin.id,
  created_at: new Date('2026-07-01'),
  updated_at: new Date('2026-07-01'),
  organization_id: ALPHA_ORG_ID,
};

/** A stored WorkflowStep row. */
function stepRow(position: number, step_type: string, config: unknown) {
  return { id: `s${position}`, workflow_id: WF_ID, position, step_type, config, organization_id: ALPHA_ORG_ID };
}

const VALID_TEXT_CONFIG = { recipient: 'customer', body: 'Hi {{customer.first_name}}, see you {{job.scheduled_date}}.' };

/** Callback-form $transaction passthrough (tx === the mocked prisma client). */
function wireTransaction() {
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── list + RBAC ────────────────────────────────────────────────────────────────

describe('GET /api/workflows + RBAC', () => {
  it('returns org workflows, tenant-scoped, newest first (ADMIN 200)', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findMany.mockResolvedValueOnce([{ ...BASE_WORKFLOW, steps: [] }]);
    const res = await request(app).get('/api/workflows').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const q = mockPrisma.workflow.findMany.mock.calls[0][0];
    expect(q.where).toMatchObject({ organization_id: ALPHA_ORG_ID });
    expect(q.orderBy).toEqual({ created_at: 'desc' });
    expect(q.include).toMatchObject({ steps: { orderBy: { position: 'asc' } } });
  });

  it('200s DISPATCHER', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.workflow.findMany.mockResolvedValueOnce([]);
    expect((await request(app).get('/api/workflows').set(authHeader('dispatcher'))).status).toBe(200);
  });

  it('403s SALES and TECHNICIAN on GET / and POST /', async () => {
    mockAuthAs('sales');
    expect((await request(app).get('/api/workflows').set(authHeader('sales'))).status).toBe(403);
    expect((await request(app).post('/api/workflows').set(authHeader('sales')).send({ name: 'x', trigger_type: 'JOB_SCHEDULED' })).status).toBe(403);
    mockAuthAs('technician');
    expect((await request(app).get('/api/workflows').set(authHeader('technician'))).status).toBe(403);
    expect((await request(app).post('/api/workflows').set(authHeader('technician')).send({ name: 'x', trigger_type: 'JOB_SCHEDULED' })).status).toBe(403);
  });
});

// ── create ──────────────────────────────────────────────────────────────────────

describe('POST /api/workflows', () => {
  it('creates a DRAFT with steps renumbered from array order (201) and audits it', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.create.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, 'WAIT', { duration_minutes: 60 }), stepRow(1, 'SEND_TEXT', {})],
    });
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({
      name: 'New flow',
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        { step_type: 'WAIT', config: { duration_minutes: 60 } },
        { step_type: 'SEND_TEXT', config: {} }, // half-configured — allowed in draft tier
      ],
    });
    expect(res.status).toBe(201);
    // stamped org + creator, DRAFT + disabled
    const data = mockPrisma.workflow.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      created_by_id: TEST_USERS.admin.id,
      status: 'DRAFT',
      is_enabled: false,
      trigger_type: 'JOB_SCHEDULED',
    });
    // steps renumbered 0..n-1 from ARRAY order, org-stamped
    const stepData = mockPrisma.workflowStep.createMany.mock.calls[0][0].data;
    expect(stepData.map((s: any) => s.position)).toEqual([0, 1]);
    expect(stepData.map((s: any) => s.step_type)).toEqual(['WAIT', 'SEND_TEXT']);
    expect(stepData.every((s: any) => s.organization_id === ALPHA_ORG_ID)).toBe(true);
    // server-computed issues surface the incomplete step
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.is_enabled).toBe(false);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.workflow_created' }));
  });

  it('201s for DISPATCHER', async () => {
    mockAuthAs('dispatcher');
    wireTransaction();
    mockPrisma.workflow.create.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [] });
    const res = await request(app).post('/api/workflows').set(authHeader('dispatcher')).send({ name: 'Flow', trigger_type: 'JOB_SCHEDULED' });
    expect(res.status).toBe(201);
  });

  it('400: more than 25 steps', async () => {
    mockAuthAs('admin');
    const steps = Array.from({ length: 26 }, () => ({ step_type: 'WAIT', config: { duration_minutes: 60 } }));
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({ name: 'Too many', trigger_type: 'JOB_SCHEDULED', steps });
    expect(res.status).toBe(400);
  });

  it('400: unknown top-level key (.strict())', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({ name: 'x', trigger_type: 'JOB_SCHEDULED', hacker_field: true });
    expect(res.status).toBe(400);
  });

  // Spec A - the in-app step is retired from AUTHORING, and the draft write tier is
  // deliberately NOT where that is enforced. Duplicate (AutomationsHomePage) POSTs a
  // workflow's stored steps verbatim, so a write tier that refused the retired label
  // would fail a copy of a legacy workflow with a raw zod enum dump instead of the
  // product's own sentence. The copy is stored, reported on this very response, and
  // refused at publish - which is the ONE place the retirement is friction.
  it('stores a legacy in-app step a duplicate carries, and reports it on the way back', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.create.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG),
        stepRow(1, 'NOTIFY_TEAM', { recipients: ['dispatcher'], body: 'New lead {{lead.name}}' }),
      ],
    });
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({
      name: 'Reminder flow (copy)',
      trigger_type: 'LEAD_CREATED',
      steps: [
        { step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG },
        { step_type: 'NOTIFY_TEAM', config: { recipients: ['dispatcher'], body: 'New lead {{lead.name}}' } },
      ],
    });
    expect(res.status).toBe(201);
    const stepData = mockPrisma.workflowStep.createMany.mock.calls[0][0].data;
    expect(stepData.map((s: any) => s.step_type)).toEqual(['SEND_TEXT', 'NOTIFY_TEAM']);
    // The product's sentence, not zod's - and it names the step's own position.
    expect(res.body.issues).toEqual([
      { step_index: 1, path: 'step_type', message: retiredInAppStepMessage(1) },
    ]);
  });

  it('still accepts every authorable step type', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.create.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 4 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [] });
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({
      name: 'Every authorable step',
      trigger_type: 'JOB_SCHEDULED',
      steps: [
        { step_type: 'WAIT', config: { duration_minutes: 60 } },
        { step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG },
        { step_type: 'SEND_EMAIL', config: { recipients: ['customer'], subject: 'Hi', body: 'Hi' } },
        { step_type: 'STOP_IF', config: { condition: 'job_cancelled' } },
      ],
    });
    expect(res.status).toBe(201);
    expect(mockPrisma.workflowStep.createMany.mock.calls[0][0].data.map((s: any) => s.step_type)).toEqual([
      'WAIT',
      'SEND_TEXT',
      'SEND_EMAIL',
      'STOP_IF',
    ]);
  });

  // ── date-anchored trigger_config (A7) ──────────────────────────────────────

  it('creates a date-anchored invoice reminder (union accepts the new trigger_config shape)', async () => {
    mockAuthAs('admin');
    wireTransaction();
    const trigger_config = { anchor: 'invoice.due_date', direction: 'before', offset_minutes: 1440 };
    mockPrisma.workflow.create.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config,
    });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config,
      steps: [stepRow(0, 'SEND_EMAIL', { recipients: ['customer'], subject: 'Due soon', body: 'Hi' })],
    });
    const res = await request(app)
      .post('/api/workflows')
      .set(authHeader('admin'))
      .send({
        name: 'Invoice due reminder',
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config,
        steps: [{ step_type: 'SEND_EMAIL', config: { recipients: ['customer'], subject: 'Due soon', body: 'Hi' } }],
      });
    expect(res.status).toBe(201);
    expect(res.body.trigger_config).toEqual(trigger_config);
    // Pins buildDefinition's normalizeTriggerConfig pass-through: a well-formed
    // anchored config must NOT surface a bogus "anchor/direction required" issue.
    // (normalizeTriggerConfig used to silently drop anchor/direction, since it only
    // ever reconstructed the legacy { offset_minutes } shape.)
    expect(res.body.issues).toEqual([]);
  });

  it('rejects a structurally invalid date-anchored trigger_config (bad anchor key) with 400', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/workflows').set(authHeader('admin')).send({
      name: 'Bad anchor',
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config: { anchor: 'not_a_real_anchor', direction: 'before', offset_minutes: 1440 },
    });
    expect(res.status).toBe(400);
  });

  it('accepts a structurally-valid but entity-mismatched anchor as a DRAFT (issue, not 400 — draft tier stays permissive)', async () => {
    mockAuthAs('admin');
    wireTransaction();
    // job.scheduled_start isn't a legal anchor for an INVOICE_DATE_ANCHORED trigger
    // (ANCHORS_FOR_ENTITY.invoice = ['invoice.due_date']) — structurally valid shape,
    // semantically wrong entity. Per the two-tier design (file header) this is a
    // computed `issue`, never a 400, at create/patch time.
    const trigger_config = { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 };
    mockPrisma.workflow.create.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config,
    });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'INVOICE_DATE_ANCHORED',
      trigger_config,
      steps: [stepRow(0, 'SEND_EMAIL', { recipients: ['customer'], subject: 'Due soon', body: 'Hi' })],
    });
    const res = await request(app)
      .post('/api/workflows')
      .set(authHeader('admin'))
      .send({
        name: 'Wrong anchor for entity',
        trigger_type: 'INVOICE_DATE_ANCHORED',
        trigger_config,
        steps: [{ step_type: 'SEND_EMAIL', config: { recipients: ['customer'], subject: 'Due soon', body: 'Hi' } }],
      });
    expect(res.status).toBe(201);
    expect(res.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'trigger_config.anchor' })]),
    );
  });
});

// ── read + tenant isolation ──────────────────────────────────────────────────────

describe('GET /api/workflows/:id', () => {
  it('returns the workflow (tenant-scoped findFirst) with steps + issues', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    const res = await request(app).get(`/api/workflows/${WF_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.workflow.findFirst.mock.calls[0][0].where).toMatchObject({ id: WF_ID, organization_id: ALPHA_ORG_ID });
    expect(res.body.steps).toHaveLength(1);
    expect(res.body).toHaveProperty('issues');
    expect(res.body).toHaveProperty('has_unpublished_changes');
    expect(res.body).toHaveProperty('published_version');
  });

  it('404s when the tenant-scoped lookup misses (cross-org)', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce(null);
    const res = await request(app).get(`/api/workflows/${WF_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(mockPrisma.workflow.findFirst.mock.calls[0][0].where).toMatchObject({ organization_id: ALPHA_ORG_ID });
  });
});

// ── patch ─────────────────────────────────────────────────────────────────────

describe('PATCH /api/workflows/:id', () => {
  it('replaces steps atomically (deleteMany + createMany, renumbered) inside a $transaction', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW }); // existence
    mockPrisma.workflow.update.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflowStep.deleteMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG), stepRow(1, 'WAIT', { duration_minutes: 120 })],
    });
    const res = await request(app).patch(`/api/workflows/${WF_ID}`).set(authHeader('admin')).send({
      steps: [
        { step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG },
        { step_type: 'WAIT', config: { duration_minutes: 120 } },
      ],
    });
    expect(res.status).toBe(200);
    expect(mockPrisma.workflowStep.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workflow_id: WF_ID }) }));
    const stepData = mockPrisma.workflowStep.createMany.mock.calls[0][0].data;
    expect(stepData.map((s: any) => s.position)).toEqual([0, 1]);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.workflow_updated' }));
  });

  it('header-only PATCH leaves steps untouched (no deleteMany)', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW }); // existence
    mockPrisma.workflow.update.mockResolvedValueOnce({ ...BASE_WORKFLOW, name: 'Renamed' });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, name: 'Renamed', steps: [] });
    const res = await request(app).patch(`/api/workflows/${WF_ID}`).set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(mockPrisma.workflowStep.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStep.createMany).not.toHaveBeenCalled();
  });

  it('404 when the workflow is missing', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce(null);
    const res = await request(app).patch(`/api/workflows/${WF_ID}`).set(authHeader('admin')).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  // The other steps of a workflow holding a legacy in-app step are still EDITABLE.
  // PATCH replaces the whole array and the builder re-sends every step it hydrated
  // (useWorkflowDraft.draftToInput), so an admin fixing a typo in their text step
  // posts the legacy step straight back. Refusing that write would block EVERY save
  // on that workflow, which is a second friction point the release note does not
  // describe - and the admin would read a raw zod enum dump rather than the product's
  // sentence. The legacy step rides along, is written back rather than silently
  // dropped, and the retirement is reported as an issue instead.
  it('saves an edit that carries a legacy in-app step, and reports the retirement', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW }); // existence
    mockPrisma.workflow.update.mockResolvedValueOnce({ ...BASE_WORKFLOW });
    mockPrisma.workflowStep.deleteMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflowStep.createMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG),
        stepRow(1, 'NOTIFY_TEAM', { recipients: ['dispatcher'], body: 'FYI' }),
      ],
    });
    const res = await request(app).patch(`/api/workflows/${WF_ID}`).set(authHeader('admin')).send({
      steps: [
        { step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG },
        { step_type: 'NOTIFY_TEAM', config: { recipients: ['dispatcher'], body: 'FYI' } },
      ],
    });
    expect(res.status).toBe(200);
    const stepData = mockPrisma.workflowStep.createMany.mock.calls[0][0].data;
    expect(stepData.map((s: any) => s.step_type)).toEqual(['SEND_TEXT', 'NOTIFY_TEAM']);
    expect(res.body.issues).toEqual([
      { step_index: 1, path: 'step_type', message: retiredInAppStepMessage(1) },
    ]);
    // Never a bare enum name: that is the internal-label copy the retirement's other
    // two doors are already tested against.
    expect(JSON.stringify(res.body.issues)).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  it('accepts a date-anchored trigger_config too (union widening applies to both create and patch)', async () => {
    mockAuthAs('admin');
    wireTransaction();
    const trigger_config = { anchor: 'estimate.valid_until', direction: 'after', offset_minutes: 60 };
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW }); // existence
    mockPrisma.workflow.update.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'ESTIMATE_DATE_ANCHORED',
      trigger_config,
    });
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'ESTIMATE_DATE_ANCHORED',
      trigger_config,
      steps: [],
    });
    const res = await request(app).patch(`/api/workflows/${WF_ID}`).set(authHeader('admin')).send({
      trigger_type: 'ESTIMATE_DATE_ANCHORED',
      trigger_config,
    });
    expect(res.status).toBe(200);
    expect(res.body.trigger_config).toEqual(trigger_config);
    const updateData = mockPrisma.workflow.update.mock.calls[0][0].data;
    expect(updateData.trigger_config).toEqual(trigger_config);
  });
});

// ── publish ─────────────────────────────────────────────────────────────────────

describe('POST /api/workflows/:id/publish', () => {
  it('400 with the issues array when the draft is not publishable (no version created)', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', {})] });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ready to publish/i);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(mockPrisma.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('publishes: version = max+1, exact definition snapshot, workflow flips PUBLISHED + enabled by default', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    mockPrisma.workflowVersion.findFirst.mockResolvedValueOnce({ version: 2 }); // current max
    mockPrisma.workflowVersion.create.mockImplementation(async (args: any) => ({
      id: 'v-new',
      version: args.data.version,
      published_at: new Date('2026-07-02'),
      definition: args.data.definition,
    }));
    mockPrisma.workflow.update.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      status: 'PUBLISHED',
      published_version_id: 'v-new',
      published_at: new Date('2026-07-02'),
      is_enabled: true,
      steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    const versionData = mockPrisma.workflowVersion.create.mock.calls[0][0].data;
    expect(versionData.version).toBe(3);
    expect(versionData.organization_id).toBe(ALPHA_ORG_ID);
    expect(versionData.published_by_id).toBe(TEST_USERS.admin.id);
    expect(versionData.definition).toEqual({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG }],
    });
    const updateData = mockPrisma.workflow.update.mock.calls[0][0].data;
    expect(updateData).toMatchObject({ status: 'PUBLISHED', published_version_id: 'v-new', is_enabled: true });
    expect(res.body.status).toBe('PUBLISHED');
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.workflow_published' }));
  });

  it('respects enable:false (publish but leave paused)', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    mockPrisma.workflowVersion.findFirst.mockResolvedValueOnce(null); // no prior versions
    mockPrisma.workflowVersion.create.mockImplementation(async (args: any) => ({ id: 'v1', version: args.data.version, published_at: new Date(), definition: args.data.definition }));
    mockPrisma.workflow.update.mockResolvedValueOnce({ ...BASE_WORKFLOW, status: 'PUBLISHED', published_version_id: 'v1', is_enabled: false, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({ enable: false });
    expect(res.status).toBe(200);
    expect(mockPrisma.workflowVersion.create.mock.calls[0][0].data.version).toBe(1);
    expect(mockPrisma.workflow.update.mock.calls[0][0].data.is_enabled).toBe(false);
  });

  // ── the retired in-app step at publish ────────────────────────────────────
  // Removing the picker entry stops the builder OFFERING the step; it does not
  // stop an organization republishing a draft that already holds one. This is
  // the one place the retirement is visible to an admin as friction, so the
  // response has to name the step and say what to do instead.
  it('400 naming the in-app step\'s position and where in-app notifications come from now', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG),
        stepRow(1, 'NOTIFY_TEAM', { recipients: ['all_admins'], body: 'FYI' }),
      ],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ready to publish/i);
    expect(res.body.issues).toEqual([
      { step_index: 1, path: 'step_type', message: expect.stringContaining('Step 2') },
    ]);
    expect(res.body.issues[0].message).toMatch(/bell/i);
    expect(res.body.issues[0].message).toMatch(/remove/i);
    expect(mockPrisma.workflowVersion.create).not.toHaveBeenCalled();
  });

  // The escape hatch, and the only route forward an admin has. Same workflow,
  // same trigger, same remaining step - deleting the retired one is the whole
  // fix, so it has to publish on the very next attempt with nothing else changed.
  it('publishes the same workflow once the in-app step is deleted', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)],
    });
    mockPrisma.workflowVersion.findFirst.mockResolvedValueOnce(null);
    mockPrisma.workflowVersion.create.mockImplementation(async (args: any) => ({
      id: 'v1', version: args.data.version, published_at: new Date(), definition: args.data.definition,
    }));
    mockPrisma.workflow.update.mockResolvedValueOnce({
      ...BASE_WORKFLOW, status: 'PUBLISHED', published_version_id: 'v1', is_enabled: true,
      steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockPrisma.workflowVersion.create.mock.calls[0][0].data.definition).toEqual({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      send_window: 'ANYTIME',
      steps: [{ position: 0, step_type: 'SEND_TEXT', config: VALID_TEXT_CONFIG }],
    });
  });

  // Keyed off the recipient, not off a step type. The check used to name the
  // in-app step; that step is retired and can no longer reach publish at all,
  // and the specific-person audience it guarded is offered by the email step too
  // - so a test still driving it through the retired type would be asserting a
  // branch nothing can enter.
  it('400 when a specific_user recipient is not in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'LEAD_CREATED',
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipient: 'specific_user',
          user_id: '9e0e0e0e-0000-0000-0000-000000000009',
          subject: 'New lead',
          body: 'New lead {{lead.name}}',
        }),
      ],
    });
    mockPrisma.user.findFirst.mockResolvedValueOnce(null); // not in org
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Selected user not found');
    expect(mockPrisma.user.findFirst.mock.calls[0][0].where).toMatchObject({ id: '9e0e0e0e-0000-0000-0000-000000000009', organization_id: ALPHA_ORG_ID });
    expect(mockPrisma.workflowVersion.create).not.toHaveBeenCalled();
  });

  // SRVW-113 — trigger_config.sub_status_id is validated structurally (a uuid)
  // by validateWorkflowDefinition, but "does it belong to THIS org" is a DB
  // lookup, resolved here at publish time, mirroring specific_user's user_id.
  it('400 when a JOB_SUB_STATUS_ENTERED sub_status_id does not resolve in the org', async () => {
    mockAuthAs('admin');
    const subStatusId = '00000000-0000-0000-0000-0000000000d1';
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: subStatusId },
      steps: [stepRow(0, 'SEND_EMAIL', { recipients: ['customer'], subject: 'Update', body: 'Now: {{job.sub_status}}' })],
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValueOnce(null); // not in org
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Selected sub-status not found');
    expect(mockPrisma.jobSubStatus.findFirst.mock.calls[0][0].where).toMatchObject({
      id: subStatusId,
      organization_id: ALPHA_ORG_ID,
    });
    expect(mockPrisma.workflowVersion.create).not.toHaveBeenCalled();
  });

  it('publishes a JOB_SUB_STATUS_ENTERED workflow when the sub_status_id resolves in the org', async () => {
    mockAuthAs('admin');
    wireTransaction();
    const subStatusId = '00000000-0000-0000-0000-0000000000d1';
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'JOB_SUB_STATUS_ENTERED',
      trigger_config: { sub_status_id: subStatusId },
      steps: [stepRow(0, 'SEND_EMAIL', { recipients: ['customer'], subject: 'Update', body: 'Now: {{job.sub_status}}' })],
    });
    mockPrisma.jobSubStatus.findFirst.mockResolvedValueOnce({ id: subStatusId });
    mockPrisma.workflowVersion.findFirst.mockResolvedValueOnce(null);
    mockPrisma.workflowVersion.create.mockImplementation(async (args: any) => ({
      id: 'v1', version: args.data.version, published_at: new Date(), definition: args.data.definition,
    }));
    mockPrisma.workflow.update.mockResolvedValueOnce({
      ...BASE_WORKFLOW, trigger_type: 'JOB_SUB_STATUS_ENTERED', status: 'PUBLISHED', published_version_id: 'v1', is_enabled: true,
      steps: [stepRow(0, 'SEND_EMAIL', { recipients: ['customer'], subject: 'Update', body: 'Now: {{job.sub_status}}' })],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/publish`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockPrisma.workflowVersion.create).toHaveBeenCalled();
  });
});

// ── toggle ────────────────────────────────────────────────────────────────────

describe('POST /api/workflows/:id/toggle', () => {
  it('400 on a DRAFT (must publish before turning on)', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, status: 'DRAFT' });
    const res = await request(app).post(`/api/workflows/${WF_ID}/toggle`).set(authHeader('admin')).send({ is_enabled: true });
    expect(res.status).toBe(400);
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled();
  });

  it('flips is_enabled on a PUBLISHED workflow', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, status: 'PUBLISHED', published_version_id: 'v1' });
    mockPrisma.workflow.update.mockResolvedValueOnce({ ...BASE_WORKFLOW, status: 'PUBLISHED', published_version_id: 'v1', is_enabled: false, steps: [] });
    mockPrisma.workflowVersion.findFirst.mockResolvedValueOnce({ version: 1, published_at: new Date(), definition: { trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps: [] } });
    const res = await request(app).post(`/api/workflows/${WF_ID}/toggle`).set(authHeader('dispatcher')).send({ is_enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.is_enabled).toBe(false);
    expect(mockPrisma.workflow.update.mock.calls[0][0]).toMatchObject({ where: { id: WF_ID }, data: { is_enabled: false } });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.workflow_toggled' }));
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('DELETE /api/workflows/:id', () => {
  it('deletes children then the workflow in dependency order (204) and audits', async () => {
    mockAuthAs('admin');
    wireTransaction();
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ id: WF_ID, name: 'Reminder flow' });
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    mockPrisma.workflowStepRun.deleteMany.mockResolvedValueOnce({ count: 3 });
    mockPrisma.workflowEnrollment.deleteMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflowVersion.deleteMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.workflowStep.deleteMany.mockResolvedValueOnce({ count: 2 });
    mockPrisma.workflow.delete.mockResolvedValueOnce({ id: WF_ID });
    const res = await request(app).delete(`/api/workflows/${WF_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(204);
    // dependency order: step_runs → enrollments → versions → steps → workflow
    const sr = mockPrisma.workflowStepRun.deleteMany.mock.invocationCallOrder[0];
    const en = mockPrisma.workflowEnrollment.deleteMany.mock.invocationCallOrder[0];
    const ve = mockPrisma.workflowVersion.deleteMany.mock.invocationCallOrder[0];
    const st = mockPrisma.workflowStep.deleteMany.mock.invocationCallOrder[0];
    const wf = mockPrisma.workflow.delete.mock.invocationCallOrder[0];
    expect(sr).toBeLessThan(en);
    expect(en).toBeLessThan(ve);
    expect(ve).toBeLessThan(st);
    expect(st).toBeLessThan(wf);
    expect(mockPrisma.workflowStepRun.deleteMany.mock.calls[0][0].where).toMatchObject({ enrollment_id: { in: ['e1', 'e2'] } });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'automation.workflow_deleted' }));
  });

  it('404 when missing', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).delete(`/api/workflows/${WF_ID}`).set(authHeader('admin'))).status).toBe(404);
  });
});

// ── dry-run test ─────────────────────────────────────────────────────────────────

describe('POST /api/workflows/:id/test', () => {
  it('walks the draft as a dry-run (per-step outcomes) and never writes enrollments/step-runs', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'WAIT', { duration_minutes: 60 }),
        stepRow(1, 'STOP_IF', { condition: 'job_completed' }),
        stepRow(2, 'SEND_TEXT', VALID_TEXT_CONFIG),
        stepRow(3, 'SEND_TEXT', {}), // invalid → needs_setup
      ],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({ send_to_me: true });
    expect(res.status).toBe(200);
    const steps = res.body.steps;
    expect(steps[0]).toMatchObject({ step_index: 0, step_type: 'WAIT', outcome: 'would_wait', detail: '1 hour' });
    expect(steps[1]).toMatchObject({ step_index: 1, step_type: 'STOP_IF', outcome: 'would_check' });
    expect(steps[1].detail).toContain('the job was completed');
    expect(steps[2]).toMatchObject({ step_index: 2, step_type: 'SEND_TEXT', outcome: 'would_send' });
    expect(steps[2].rendered.body).toContain('Sarah'); // sample context substituted
    expect(steps[3]).toMatchObject({ step_index: 3, step_type: 'SEND_TEXT', outcome: 'needs_setup' });

    // send_to_me: only the ONE valid send step is delivered to the CALLER; one in-app emit
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const mail = mockSendEmail.mock.calls[0][0];
    expect(mail.to).toBe(TEST_USERS.admin.email);
    expect(mail.subject).toMatch(/^\[Test\]/);
    expect(mail).not.toHaveProperty('record');
    expect(res.body.delivered).toContain('email');
    expect(res.body.delivered).toContain('in_app');

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const n = mockEmit.mock.calls[0][0];
    // The verb the engine's deleted in-app executor used to share. The receipt is
    // the one deliberate Automation-Center write to the bell, so it is pinned here.
    expect(n.verb).toBe('automation.message');
    expect(n.object.type).toBe('AUTOMATION');
    expect(n.entity.recipient_ids).toEqual([TEST_USERS.admin.id]);

    // pure dry-run — never persists
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
  });

  // Spec B slice 1. The builder is NOT inert before a task workflow can be published: Test ->
  // send to me walks the draft against SAMPLE_CONTEXT and really sends. The task sample values
  // this slice owns are exactly what makes that render, so it is pinned here rather than
  // assumed.
  it('renders a task workflow from sample values and previews it to the caller', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'TASK_CREATED',
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['assignees'],
          subject: 'New task: {{task.title}}',
          body: [
            '{{task.number}} / {{task.due_date}} / {{task.status}} / {{task.priority}}',
            '{{task.assignee_names}} / {{task.linked_record}} / {{task.link}}',
          ].join('\n'),
        }),
      ],
    });

    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ send_to_me: true });

    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_type: 'SEND_EMAIL', outcome: 'would_send' });
    const rendered = res.body.steps[0].rendered;
    expect(rendered.subject).toContain('Order the replacement thermostat');
    // Every task field resolved - a missing SAMPLE_CONTEXT entry leaves the raw token behind.
    expect(rendered.body).not.toContain('{{');
    expect(rendered.body).toContain('T00042');
    expect(rendered.body).toContain('Job J00042');

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].to).toBe(TEST_USERS.admin.email);
  });

  // Slice 14: "Task is done" adds who finished the task and when. The preview renders from
  // SAMPLE_CONTEXT, so a field with no sample value would preview as its raw token.
  it('previews a "Task is done" workflow with the completed-by and completed-at fields filled in', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'TASK_COMPLETED',
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['assignees', 'watchers'],
          subject: 'Done: {{task.title}}',
          body: '{{task.completed_by}} finished {{task.number}} on {{task.completed_at}} ({{task.linked_record}})',
        }),
      ],
    });

    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_type: 'SEND_EMAIL', outcome: 'would_send' });
    const body = res.body.steps[0].rendered.body as string;
    expect(body).not.toContain('{{');
    expect(body).toBe('Dana Whitfield finished T00042 on July 17, 2026 at 3:45 PM (Job J00042)');
  });

  // Slice 15: "Task is cancelled" adds who cancelled the task and when - same preview rule.
  it('previews a "Task is cancelled" workflow with the cancelled-by and cancelled-at fields filled in', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'TASK_CANCELLED',
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['assignees', 'watchers'],
          subject: 'Cancelled: {{task.title}}',
          body: '{{task.cancelled_by}} cancelled {{task.number}} on {{task.cancelled_at}} ({{task.linked_record}})',
        }),
      ],
    });

    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_type: 'SEND_EMAIL', outcome: 'would_send' });
    const body = res.body.steps[0].rendered.body as string;
    expect(body).not.toContain('{{');
    expect(body).toBe('Dana Whitfield cancelled T00042 on July 17, 2026 at 3:45 PM (Job J00042)');
  });

  it('without send_to_me it delivers nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
    expect(res.body.delivered).toEqual([]);
  });

  it('404s a cross-org workflow', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce(null);
    expect((await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({})).status).toBe(404);
  });

  it('previews EVERY audience in a recipients[] multi-select config, not blank/first-only', async () => {
    mockAuthAs('admin');
    // BASE_WORKFLOW's trigger is JOB_SCHEDULED (entity 'job'), which offers salesperson.
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['customer', 'salesperson'],
          subject: 'Hi {{customer.first_name}}',
          body: 'Hello {{customer.first_name}}',
        }),
      ],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_index: 0, step_type: 'SEND_EMAIL', outcome: 'would_send' });
    expect(res.body.steps[0].detail).toContain('the customer');
    expect(res.body.steps[0].detail).toContain('the salesperson');
  });

  it('legacy singular `recipient` still previews correctly (back-compat fallback to recipients[])', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ ...BASE_WORKFLOW, steps: [stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG)] });
    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body.steps[0].detail).toBe('Would send to the customer');
  });

  it('an anchored WAIT dry-runs to the anchor text, never "undefined minutes"', async () => {
    mockAuthAs('admin');
    // LEAD_CREATED → entity 'lead', the only trigger entity that legally offers
    // the 'lead.walkthrough_scheduled_at' anchor (ANCHORS_FOR_ENTITY) and isn't
    // a TERMINAL_TRIGGERS member, so the step passes validation as WAIT/would_wait
    // instead of getting flagged needs_setup.
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      trigger_type: 'LEAD_CREATED',
      steps: [
        stepRow(0, 'WAIT', {
          mode: 'anchored',
          anchor: 'lead.walkthrough_scheduled_at',
          direction: 'before',
          offset_minutes: 1440,
        }),
      ],
    });
    const res = await request(app).post(`/api/workflows/${WF_ID}/test`).set(authHeader('admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_index: 0, step_type: 'WAIT', outcome: 'would_wait' });
    expect(res.body.steps[0].detail).toContain('1 day before the walkthrough');
    expect(res.body.steps[0].detail).not.toContain('undefined');
  });
});

// ── unrecognised step types ───────────────────────────────────────────
// A stored step can name a WorkflowStepType this build no longer configures (the
// Postgres enum keeps retired labels). Every read path validates, so the failure
// mode has to be an explained issue, never a 500 on the whole list page.

// ── "If empty, fill with" in the dry run ────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// The step preview toggles between sample data and EMPTY fields, and the empty rendering goes
// through the same renderer and the same per-step fallback map a real send uses.

describe('POST /api/workflows/:id/test with empty_fields', () => {
  it('renders every field empty and fills from the step fallbacks, not the sample context', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['customer'],
          subject: 'Visit {{job.number}}',
          body: "Hi {{customer.first_name}}, who's coming: {{technician.names}}.",
          fallbacks: { 'technician.names': 'a member of the crew', 'customer.first_name': 'there' },
        }),
      ],
    });
    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ empty_fields: true });
    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_index: 0, outcome: 'would_send' });
    expect(res.body.steps[0].rendered.subject).toBe('Visit ');
    expect(res.body.steps[0].rendered.body).toBe("Hi there, who's coming: a member of the crew.");
    // Nothing from the sample context leaks into the empty-state preview.
    expect(res.body.steps[0].rendered.body).not.toContain('Sarah');
  });

  /**
   * WHAT AN ORGANISATION SEES IF A SAVED BODY STILL CARRIES THE RETIRED FIELD.
   *
   * `{{recipient.first_name}}` was removed from the catalogue on 2026-09-15 (see `BASE` in
   * catalog.ts). The nine seeded bodies that used it are rewritten by
   * 20260915170000_drop_recipient_first_name_from_saved_copy, and this is what the Test dialog
   * does for any row that migration could not reach: it REFUSES TO PREVIEW rather than showing
   * a rendering, and it names the field.
   *
   * That refusal is the protective half of the removal and it is worth pinning at the API
   * boundary and not only in workflowValidation's own unit tests, because it is what stops the
   * dialog offering to mail a body whose real send would print raw braces. `rendered` being
   * absent is the load-bearing half of the assertion; the copy is asserted too, since an error
   * that did not say WHICH field would leave the office with nothing to act on.
   */
  it('refuses to preview a body that still carries the retired recipient field, and says which', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_EMAIL', {
          recipients: ['customer'],
          subject: 'Job {{job.number}}',
          body: 'Hi {{recipient.first_name}}, see you soon.',
          fallbacks: {},
        }),
      ],
    });
    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ empty_fields: true });
    expect(res.status).toBe(200);
    expect(res.body.steps[0]).toMatchObject({ step_index: 0, outcome: 'needs_setup' });
    expect(res.body.steps[0].detail).toContain('{{recipient.first_name}}');
    // Never a preview of copy that cannot be sent: the dialog offers nothing to mail.
    expect(res.body.steps[0].rendered).toBeUndefined();
  });

  it('renders the seeded default for a step stored without a fallbacks key', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, 'SEND_TEXT', { recipient: 'customer', body: "Who's coming: {{technician.names}}." })],
    });
    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ empty_fields: true });
    expect(res.status).toBe(200);
    expect(res.body.steps[0].rendered.body).toBe("Who's coming: Our team.");
  });
});

describe('a workflow holding a step type this build does not recognise', () => {
  const RETIRED_STEP = 'RETIRED_STEP_TYPE';

  it('GET /api/workflows still returns 200, with an issue naming that step', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findMany.mockResolvedValueOnce([
      { ...BASE_WORKFLOW, steps: [stepRow(0, RETIRED_STEP, { recipients: ['all_admins'], body: 'FYI' })] },
    ]);
    const res = await request(app).get('/api/workflows').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body[0].issues).toContainEqual(
      expect.objectContaining({ step_index: 0, path: 'step_type', message: UNSUPPORTED_STEP_MESSAGE }),
    );
  });

  it('GET /api/workflows/:id still returns 200 for the detail page', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, RETIRED_STEP, {}), stepRow(1, 'SEND_TEXT', VALID_TEXT_CONFIG)],
    });
    const res = await request(app).get(`/api/workflows/${WF_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.issues).toContainEqual(
      expect.objectContaining({ step_index: 0, path: 'step_type', message: UNSUPPORTED_STEP_MESSAGE }),
    );
  });

  it('the test dialog reports it as not sending, and send-to-me dispatches nothing for it', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [stepRow(0, RETIRED_STEP, { recipients: ['all_admins'], body: 'FYI' }), stepRow(1, 'SEND_TEXT', VALID_TEXT_CONFIG)],
    });
    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ send_to_me: true });
    expect(res.status).toBe(200);
    expect(res.body.steps[0].outcome).not.toBe('would_send');
    expect(res.body.steps[0]).toMatchObject({ step_index: 0, detail: UNSUPPORTED_STEP_MESSAGE });
    expect(res.body.steps[0]).not.toHaveProperty('rendered');
    expect(res.body.steps[1]).toMatchObject({ step_index: 1, outcome: 'would_send' });

    // exactly ONE email, and it is the valid step's copy. The unrecognised step sent nothing.
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].text).not.toContain('FYI');
  });

  // The retired in-app step is the one member of this family the product made a
  // decision about, and the Test dialog is the third surface an admin meets it on
  // (after the config drawer and the publish attempt). Saying "no longer
  // supported" here while the other two explain the bell is how one retirement
  // starts reading like three unrelated faults. Same split as the run path's
  // RETIRED_IN_APP_STEP_DETAIL / UNRUNNABLE_STEP_DETAIL.
  it('the test dialog explains the retired in-app step in the same words as publish', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({
      ...BASE_WORKFLOW,
      steps: [
        stepRow(0, 'SEND_TEXT', VALID_TEXT_CONFIG),
        stepRow(1, 'NOTIFY_TEAM', { recipients: ['all_admins'], body: 'FYI' }),
      ],
    });
    const res = await request(app)
      .post(`/api/workflows/${WF_ID}/test`)
      .set(authHeader('admin'))
      .send({ send_to_me: false });
    expect(res.status).toBe(200);
    expect(res.body.steps[1].outcome).not.toBe('would_send');
    expect(res.body.steps[1].detail).toBe(retiredInAppStepMessage(1));
    expect(res.body.steps[1].detail).not.toBe(UNSUPPORTED_STEP_MESSAGE);
  });
});

// ── activity ─────────────────────────────────────────────────────────────────────

describe('GET /api/workflows/:id/activity', () => {
  it('unions legacy + new rows, sorted newest-first, mapping legacy SEND_SMS → SEND_TEXT', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ id: WF_ID, legacy_rule_id: 'a0000000-0000-0000-0000-0000000000cc' });
    mockPrisma.workflowStepRun.findMany.mockResolvedValueOnce([
      {
        id: 'run-new',
        created_at: new Date('2026-07-05'),
        step_index: 1,
        step_type: 'SEND_EMAIL',
        status: 'SENT',
        recipient_summary: 'sarah@example.com',
        detail: 'sent',
        enrollment: { entity_type: 'job', entity_id: 'j1', entity_label: 'J00042' },
      },
    ]);
    mockPrisma.automationRun.findMany.mockResolvedValueOnce([
      {
        id: 'run-legacy',
        executed_at: new Date('2026-07-03'),
        created_at: new Date('2026-07-03'),
        status: 'SENT',
        recipient_summary: 'old',
        detail: 'legacy sent',
        entity_label: 'J00001',
        rule: { action_type: 'SEND_SMS' },
      },
    ]);
    const res = await request(app).get(`/api/workflows/${WF_ID}/activity`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].source).toBe('workflow'); // 07-05 newest
    expect(res.body.rows[1].source).toBe('legacy');
    expect(res.body.rows[1].step_type).toBe('SEND_TEXT'); // SEND_SMS mapped
    expect(res.body.rows[0].entity_label).toBe('J00042');
    expect(mockPrisma.workflowStepRun.findMany.mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      enrollment: { workflow_id: WF_ID },
    });
    expect(mockPrisma.automationRun.findMany.mock.calls[0][0].where).toMatchObject({
      rule_id: 'a0000000-0000-0000-0000-0000000000cc',
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('carries each step run\'s per-audience outcomes, and an empty list on a legacy row', async () => {
    mockAuthAs('admin');
    const audience_outcomes = [
      { audience: 'customer', label: 'the customer', outcome: 'skipped', summary: 'The customer has no email address on file' },
      { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
    ];
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ id: WF_ID, legacy_rule_id: 'a0000000-0000-0000-0000-0000000000cc' });
    mockPrisma.workflowStepRun.findMany.mockResolvedValueOnce([
      {
        id: 'run-new',
        created_at: new Date('2026-07-05'),
        step_index: 1,
        step_type: 'SEND_EMAIL',
        status: 'SENT',
        recipient_summary: 'mike@org.com',
        detail: 'Sent to 1',
        audience_outcomes,
        enrollment: { entity_type: 'job', entity_id: 'j1', entity_label: 'J00042' },
      },
    ]);
    mockPrisma.automationRun.findMany.mockResolvedValueOnce([
      {
        id: 'run-legacy',
        executed_at: new Date('2026-07-03'),
        created_at: new Date('2026-07-03'),
        status: 'SENT',
        recipient_summary: 'old',
        detail: 'legacy sent',
        entity_label: 'J00001',
        rule: { action_type: 'SEND_EMAIL' },
      },
    ]);
    const res = await request(app).get(`/api/workflows/${WF_ID}/activity`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.rows[0].audience_outcomes).toEqual(audience_outcomes);
    expect(res.body.rows[1].audience_outcomes).toEqual([]);
  });

  it('skips the legacy query when the workflow has no legacy_rule_id', async () => {
    mockAuthAs('admin');
    mockPrisma.workflow.findFirst.mockResolvedValueOnce({ id: WF_ID, legacy_rule_id: null });
    mockPrisma.workflowStepRun.findMany.mockResolvedValueOnce([]);
    const res = await request(app).get(`/api/workflows/${WF_ID}/activity`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.automationRun.findMany).not.toHaveBeenCalled();
  });
});

// ── catalog ──────────────────────────────────────────────────────────────────────

describe('GET /api/workflows/catalog', () => {
  it('serves triggers/actions/templates verbatim + the stop_if block', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.triggers.JOB_SCHEDULED.label).toBeTruthy();
    expect(res.body.actions.SEND_EMAIL.label).toBeTruthy();
    expect(res.body.templates.length).toBeGreaterThanOrEqual(11);
    expect(res.body.stop_if.conditions.job).toContain('job_completed');
    expect(res.body.stop_if.labels.job_completed).toBeTruthy();
  });

  /**
   * Asserted against the module rather than re-listed, deliberately. This endpoint's contract is
   * "whatever the server will actually apply, verbatim" - a second copy of the map here could
   * drift, and the way it would drift is the builder showing an author one sentence in the box
   * while the send renders another. `mergeFieldFallbacks.test.ts` is where the CONTENTS are
   * pinned; this is where the WIRE is.
   */
  it('serves the seeded "If empty, fill with" defaults the builder pre-fills a new step with', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.default_fallbacks).toEqual(DEFAULT_MERGE_FIELD_FALLBACKS);
    // Not vacuous: an endpoint serving `{}` would satisfy a bare toEqual against an empty map.
    expect(Object.keys(res.body.default_fallbacks).length).toBeGreaterThanOrEqual(13);
    expect(res.body.default_fallbacks['job.visit_location']).toBeTruthy();
  });

  it('serves the v2.1 recipient audiences per trigger+action, channel-constrained', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const jobEmail = res.body.audiences.JOB_SCHEDULED.SEND_EMAIL;
    expect(jobEmail.map((a: { key: string }) => a.key)).toEqual([
      'customer', 'assigned_team', 'dispatcher', 'salesperson', 'all_admins', 'all_dispatchers', 'specific_user', 'custom',
    ]);
    // Spec C slice 1: the text channel serves the SAME audiences as email, minus the
    // email-only `custom`. Asserted here as the equivalence rather than as a key list,
    // because the point of this case is that the SERVED payload matches audiencesFor() -
    // a second hand-written list would just be a third place to keep in step.
    expect(res.body.audiences.JOB_SCHEDULED.SEND_SMS.map((a: { key: string }) => a.key)).toEqual(
      jobEmail.map((a: { key: string }) => a.key).filter((k: string) => k !== 'custom'),
    );
    expect(res.body.audiences.INVOICE_SENT.SEND_EMAIL.map((a: { key: string }) => a.key)).not.toContain('salesperson');
    const salesperson = jobEmail.find((a: { key: string }) => a.key === 'salesperson');
    expect(salesperson.label).toBeTruthy();
    expect(salesperson.hint).toBe('Skipped if no salesperson is set.');
    const customer = jobEmail.find((a: { key: string }) => a.key === 'customer');
    expect(customer.hint).toBeUndefined();
  });

  // Replaces the in-app audience assertion that used to sit in the case above,
  // which pinned WHICH audiences the retired action offered. The catalogue is the
  // builder's menu; a retired action has no business appearing on it at all, and
  // the frontend reads audiences with a `?? []` fallback, so a half-done removal
  // would show an empty multi-select rather than fail anything.
  it('carries no in-app action and no audience list keyed to it', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.actions).sort()).toEqual(['SEND_EMAIL', 'SEND_SMS']);
    for (const [trigger, byAction] of Object.entries(res.body.audiences as Record<string, object>)) {
      expect(Object.keys(byAction).sort(), `${trigger} serves the wrong action keys`).toEqual([
        'SEND_EMAIL',
        'SEND_SMS',
      ]);
    }
  });

  it('serves anchor options in the catalog (ANCHOR_OPTIONS, unmodified)', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const both = ['before', 'after'];
    expect(res.body.anchors.invoice).toEqual([
      { key: 'invoice.due_date', label: 'the invoice due date', directions: both },
    ]);
    expect(res.body.anchors.job).toEqual([{ key: 'job.scheduled_start', label: 'the appointment', directions: both }]);
    // Spec #1751 D8 ADDED three lead anchors alongside the walkthrough one (it is never
    // substituted), in the order ANCHORS_FOR_ENTITY lists them — which is the order the builder's
    // dropdown shows them in, so the list is asserted whole rather than by membership.
    //
    // `directions` rides on the wire because the builder reads it to decide which offsets to
    // OFFER: a stage clock records a moment as it happens, so counting BEFORE one can never fire
    // and the validator refuses to save it.
    expect(res.body.anchors.lead).toEqual([
      { key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough', directions: both },
      { key: 'lead.created_at', label: 'the lead arriving', directions: ['after'] },
      { key: 'lead.contacted_at', label: 'first contact', directions: ['after'] },
      { key: 'lead.last_visit_completed_at', label: 'the completed walkthrough', directions: ['after'] },
    ]);
    expect(res.body.anchors.estimate).toEqual([
      { key: 'estimate.valid_until', label: 'the estimate expiration', directions: both },
    ]);
  });

  // SERV10X-70: the "Send text" step unlocks per-org, not via a global flag —
  // capabilities.sms_available is true only when the org can actually text.
  describe('capabilities.sms_available', () => {
    function orgRow(overrides: Record<string, unknown> = {}) {
      return {
        ctm_account_id: '500001',
        ctm_sms_ready: true,
        sms_sending_enabled: true,
        plan: 'PRO',
        trial_ends_at: null,
        feature_overrides: { phone: true },
        ...overrides,
      };
    }

    it('true when the org is connected, A2P-ready, kill-switch-on, and entitled', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow());
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(res.body.capabilities).toEqual({ sms_available: true });
    });

    it('false when CTM was never connected (no ctm_account_id) — the common default', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow({ ctm_account_id: null }));
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.body.capabilities.sms_available).toBe(false);
    });

    it('false when A2P registration is still pending', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow({ ctm_sms_ready: false }));
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.body.capabilities.sms_available).toBe(false);
    });

    it('false when the org kill switch is off', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow({ sms_sending_enabled: false }));
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.body.capabilities.sms_available).toBe(false);
    });

    it('false when the org never turned Communication on (PRO, feature_overrides.phone: false)', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow({ feature_overrides: { phone: false } }));
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.body.capabilities.sms_available).toBe(false);
    });

    it('false for a STARTER org with no override (not entitled to phone at all)', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(orgRow({ plan: 'STARTER', feature_overrides: {} }));
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.body.capabilities.sms_available).toBe(false);
    });

    it('false (fails closed) when the org row cannot be read', async () => {
      mockAuthAs('admin');
      mockPrisma.organization.findUnique.mockResolvedValue(null);
      const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(res.body.capabilities.sms_available).toBe(false);
    });
  });
});

// ── cutover ──────────────────────────────────────────────────────────────────────

describe('legacy /api/automations retirement', () => {
  it('GET /api/automations no longer resolves (404, mount removed)', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/automations').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('GET /api/workflows/catalog is the sole catalog surface (200, catalog shape)', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/workflows/catalog').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.triggers).toBeTruthy();
    expect(res.body.actions).toBeTruthy();
    expect(res.body.templates.length).toBeGreaterThan(0);
  });
});
