import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { seedDefaultAutomationsForOrg } from '../seedDefaultAutomations';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../mergeFieldFallbacks';
import { dateAnchorConfigOf } from '../cron';

const mockPrisma = prisma as any;
const ORG = '00000000-0000-0000-0000-000000000001';
const PRO_ORG_ROW = { plan: 'PRO', trial_ends_at: null, feature_overrides: null };

/** Wire $transaction to run against real-shaped fakes, capturing every write. */
function wireTx() {
  const workflowCreates: any[] = [];
  const stepCreates: any[] = [];
  const versionCreates: any[] = [];
  const workflowUpdates: any[] = [];
  let nextId = 0;

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      workflow: {
        create: vi.fn((args: any) => {
          const id = `wf-${nextId++}`;
          workflowCreates.push({ id, ...args.data });
          return Promise.resolve({ id, ...args.data });
        }),
        update: vi.fn((args: any) => {
          workflowUpdates.push(args);
          return Promise.resolve({ id: args.where.id, ...args.data });
        }),
      },
      workflowStep: {
        create: vi.fn((args: any) => {
          stepCreates.push(args.data);
          return Promise.resolve({ id: `step-${nextId++}`, ...args.data });
        }),
      },
      workflowVersion: {
        create: vi.fn((args: any) => {
          const id = `ver-${nextId++}`;
          versionCreates.push({ id, ...args.data });
          return Promise.resolve({ id, ...args.data });
        }),
      },
    }),
  );

  return { workflowCreates, stepCreates, versionCreates, workflowUpdates };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Entitled by default - every pre-existing test here exercises the normal seed
  // path, not the entitlement gate (see the dedicated describe block below).
  mockPrisma.organization.findUnique.mockResolvedValue(PRO_ORG_ROW);
});

describe('seedDefaultAutomationsForOrg', () => {
  it('creates every DEFAULT_AUTOMATIONS entry for an org with none yet', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null); // nothing exists yet
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.created.sort()).toEqual(DEFAULT_AUTOMATIONS.map((a) => a.builtin_key).sort());
    expect(result.skipped).toEqual([]);
    expect(captured.workflowCreates).toHaveLength(DEFAULT_AUTOMATIONS.length);
    expect(captured.stepCreates).toHaveLength(DEFAULT_AUTOMATIONS.length);
    expect(captured.versionCreates).toHaveLength(DEFAULT_AUTOMATIONS.length);
    expect(captured.workflowUpdates).toHaveLength(DEFAULT_AUTOMATIONS.length);
  });

  // is_enabled comes from the registry, not from a hardcoded literal. The seeder
  // is idempotent by SKIP — an existing row is left completely alone — so a
  // workflow seeded disabled can never be enabled by re-running the seeder.
  // Seeding it in its final state is therefore the only honest option, and the
  // hard rule holds a different way: an entry only carries seed_enabled: true in
  // the same change that deletes the hard-coded sender it replaces.
  it('seeds every workflow PUBLISHED, with is_enabled taken from the registry', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    for (const created of captured.workflowCreates) {
      const def = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === created.builtin_key);
      expect(def, `no registry entry for ${created.builtin_key}`).toBeDefined();
      expect(created.status).toBe('PUBLISHED');
      expect(created.is_enabled).toBe(def!.seed_enabled);
    }
  });

  // The safety property, expressed in code rather than by convention: an entry
  // that says it should land switched off really does land switched off. Without
  // this, `seed_enabled` could silently degrade into a field nothing reads.
  it('seeds an entry disabled when its registry entry says seed_enabled: false', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG, [
      {
        builtin_key: 'test-only-not-cut-over',
        name: 'Not yet cut over',
        description: 'Stands in for a built-in whose hard-coded sender still fires.',
        trigger_type: 'JOB_SCHEDULED',
        recipients: ['customer'],
        subject: 'Service Scheduled: {{job.number}}',
        body: 'Hi {{customer.first_name}}.',
        seed_enabled: false,
      },
    ]);

    expect(captured.workflowCreates).toHaveLength(1);
    expect(captured.workflowCreates[0].status).toBe('PUBLISHED');
    expect(captured.workflowCreates[0].is_enabled).toBe(false);
  });

  it('seeds an entry enabled when its registry entry says seed_enabled: true', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG, [
      {
        builtin_key: 'test-only-cut-over',
        name: 'Already cut over',
        description: 'Stands in for a built-in whose hard-coded sender has been deleted.',
        trigger_type: 'JOB_SCHEDULED',
        recipients: ['customer'],
        subject: 'Service Scheduled: {{job.number}}',
        body: 'Hi {{customer.first_name}}.',
        seed_enabled: true,
      },
    ]);

    expect(captured.workflowCreates).toHaveLength(1);
    expect(captured.workflowCreates[0].is_enabled).toBe(true);
  });

  it('scopes every write to the org (organization_id set on workflow, step, and version)', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    for (const row of [...captured.workflowCreates, ...captured.stepCreates, ...captured.versionCreates]) {
      expect(row.organization_id).toBe(ORG);
    }
  });

  it('points published_version_id at the version it just created', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    // One update per workflow, each pointing at a version this same run created.
    const versionIds = new Set(captured.versionCreates.map((v) => v.id));
    for (const update of captured.workflowUpdates) {
      expect(versionIds.has(update.data.published_version_id)).toBe(true);
    }
  });

  it('the frozen version definition matches the registry entry exactly (trigger, recipients, subject, body)', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    const jobScheduled = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-job-scheduled')!;
    const version = captured.versionCreates.find((v) => v.definition.trigger_type === 'JOB_SCHEDULED');
    expect(version.definition).toEqual({
      trigger_type: 'JOB_SCHEDULED',
      trigger_config: null,
      send_window: 'ANYTIME',
      steps: [
        {
          position: 0,
          step_type: 'SEND_EMAIL',
          config: {
            recipients: jobScheduled.recipients,
            subject: jobScheduled.subject,
            body: jobScheduled.body,
            // "If empty, fill with" is seeded explicitly for a new org, so the popover shows the
            // words the copy has always rendered rather than relying on the read-side default.
            fallbacks: DEFAULT_MERGE_FIELD_FALLBACKS,
          },
        },
      ],
    });
  });

  // The unique index (organization_id, builtin_key) is the real backstop —
  // this check-then-insert is what keeps a re-run a clean no-op instead of a
  // caught constraint violation on every single entry, every time.
  it('is idempotent — an org with every builtin_key already present creates nothing', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue({ id: 'already-exists' });
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.created).toEqual([]);
    expect(result.skipped.sort()).toEqual(DEFAULT_AUTOMATIONS.map((a) => a.builtin_key).sort());
    expect(captured.workflowCreates).toHaveLength(0);
  });

  it('partial state: only the missing builtin_keys get created, the rest are skipped', async () => {
    const alreadySeeded = new Set(['default-job-scheduled', 'default-job-rescheduled']);
    mockPrisma.workflow.findFirst.mockImplementation((args: any) =>
      Promise.resolve(alreadySeeded.has(args.where.builtin_key) ? { id: 'existing' } : null),
    );
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.skipped.sort()).toEqual([...alreadySeeded].sort());
    expect(result.created).toHaveLength(DEFAULT_AUTOMATIONS.length - alreadySeeded.size);
    expect(captured.workflowCreates).toHaveLength(DEFAULT_AUTOMATIONS.length - alreadySeeded.size);
  });

  // ── Spec B slice 7: the date-anchored default's timing ─────────────────────
  //
  // THE regression test for the defect that would have killed the reminder silently.
  // buildDefinition used to hardcode `trigger_config: null` and the create used to write
  // `Prisma.DbNull` unconditionally, because all thirteen original defaults are event
  // triggers. Seeded that way the reminder workflow publishes, enables, validates and reads
  // back correctly in the builder - and cron.ts's dateAnchorConfigOf then returns null on
  // every tick, logs "invalid trigger_config - skipping", and the reminder never fires for
  // any org, ever, with nothing red anywhere.
  //
  // Asserted against the POLLER's own parser rather than a re-implementation of it: that
  // function is the thing that decides to skip, so it is the only thing whose agreement
  // proves the row is usable.
  it("persists the date-anchored default's trigger_config to the row, readable by the poller", async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    const reminder = captured.workflowCreates.find((w) => w.builtin_key === 'default-task-due-reminder');
    expect(reminder, 'default-task-due-reminder was not seeded').toBeDefined();
    expect(reminder.trigger_config).toEqual({
      anchor: 'task.due_at',
      direction: 'before',
      offset_minutes: 24 * 60,
    });
    expect(dateAnchorConfigOf({ trigger_config: reminder.trigger_config } as never)).toEqual({
      anchor: 'task.due_at',
      direction: 'before',
      offsetMinutes: 24 * 60,
    });
  });

  // The frozen version definition is what an enrollment executes against, so the config has to
  // reach BOTH places - the row the poller reads and the version the engine replays.
  it("freezes the date-anchored default's trigger_config into the published version too", async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    const version = captured.versionCreates.find((v) => v.definition.trigger_type === 'TASK_DATE_ANCHORED');
    expect(version.definition.trigger_config).toEqual({
      anchor: 'task.due_at',
      direction: 'before',
      offset_minutes: 24 * 60,
    });
  });

  // The other seventeen must keep writing a JSON null, not an object: the validator refuses a
  // config on an event trigger outright, so a stray one would make a seeded default
  // unpublishable the next time an admin edited it.
  it('leaves every event-trigger default with no trigger_config at all', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    for (const created of captured.workflowCreates) {
      const def = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === created.builtin_key)!;
      if (def.trigger_config) continue;
      expect(dateAnchorConfigOf({ trigger_config: created.trigger_config } as never)).toBeNull();
    }
  });

  // An org that has already edited its copy of a default keeps the edit. The seeder never
  // reads, diffs or repairs an existing row - it skips on (organization_id, builtin_key) and
  // moves on - so an org's own subject, body, audience and enabled state all survive a re-run.
  it('re-running over an edited copy of a task default touches nothing', async () => {
    mockPrisma.workflow.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args.where.builtin_key === 'default-task-created' ? { id: 'edited-and-disabled' } : null),
    );
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.skipped).toEqual(['default-task-created']);
    expect(captured.workflowCreates.map((w) => w.builtin_key)).not.toContain('default-task-created');
    expect(captured.workflowUpdates.every((u) => 'published_version_id' in u.data)).toBe(true);
  });

  it('checks existence scoped to (organization_id, builtin_key), not builtin_key alone', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    wireTx();

    await seedDefaultAutomationsForOrg(ORG);

    for (const call of mockPrisma.workflow.findFirst.mock.calls) {
      expect(call[0].where.organization_id).toBe(ORG);
      expect(call[0].where.builtin_key).toBeTruthy();
    }
  });
});

// Seeding runs on prod promotion is a one-way door - the seeder is idempotent by
// SKIP, so a row created for an unentitled org can't be corrected by re-running
// it. The rows must never exist in the first place. (#1069)
describe('seedDefaultAutomationsForOrg - entitlement gate', () => {
  it('a STARTER org gets nothing seeded and no existence checks are even run', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ plan: 'STARTER', trial_ends_at: null, feature_overrides: null });
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.created).toEqual([]);
    expect(result.entitled).toBe(false);
    expect(mockPrisma.workflow.findFirst).not.toHaveBeenCalled();
    expect(captured.workflowCreates).toHaveLength(0);
  });

  it('a STARTER org with an explicit automations override is still seeded - the real entitlement resolver is used', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({
      plan: 'STARTER',
      trial_ends_at: null,
      feature_overrides: { automations: true },
    });
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.entitled).toBe(true);
    expect(captured.workflowCreates).toHaveLength(DEFAULT_AUTOMATIONS.length);
  });

  it('a missing organization row fails closed - nothing seeded', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(null);
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.entitled).toBe(false);
    expect(captured.workflowCreates).toHaveLength(0);
  });

  // Spec B slice 7, stated as its own case rather than left implied by the generic assertion
  // above: the five task defaults are the ones that arrive ENABLED with no built-in sender
  // retired to offset them, so "an unentitled org receives none of them, and no partial rows"
  // is the property worth naming. The gate is also a one-way door - the seeder skips existing
  // rows, so an org unentitled at seed time cannot be corrected by re-running.
  it('a STARTER org receives none of the five task defaults and no partial rows', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ plan: 'STARTER', trial_ends_at: null, feature_overrides: null });
    const captured = wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    const TASK_KEYS = [
      'default-task-created',
      'default-task-assigned',
      'default-task-comment-added',
      'default-task-deleted',
      'default-task-due-reminder',
    ];
    for (const key of TASK_KEYS) {
      expect(result.created, `${key} must not be created for an unentitled org`).not.toContain(key);
      expect(result.skipped).toContain(key);
    }
    expect(captured.workflowCreates).toHaveLength(0);
    expect(captured.stepCreates).toHaveLength(0);
    expect(captured.versionCreates).toHaveLength(0);
  });

  it('a PRO org reports entitled: true on the normal path', async () => {
    mockPrisma.workflow.findFirst.mockResolvedValue(null);
    wireTx();

    const result = await seedDefaultAutomationsForOrg(ORG);

    expect(result.entitled).toBe(true);
  });
});
