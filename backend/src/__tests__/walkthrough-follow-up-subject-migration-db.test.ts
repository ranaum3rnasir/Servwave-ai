/* =============================================================================
   S04.20 - the walkthrough follow-up email's subject becomes "Site Visit Finished", applied for real.

   Proves against real Postgres, the way Render applies it (the Prisma deploy command), on a prod-shaped copy
   (every migration BEFORE this one, companies seeded with the built-in follow-up in different states):
     - a company whose copy still holds the old default subject now has the new one, on the live step the builder
       reads AND on the frozen version the engine renders; the new subject is the registry's own, not a copy;
     - a company that edited the subject keeps it, and keeps every one of its versions exactly as they were;
     - a hand-built automation that happens to share the old words, and the other built-ins, are not touched;
     - everything else on the rewritten rows (recipients, body, fallbacks, version numbers) is unchanged;
     - a second run changes nothing.

   Each case builds its own throwaway database on the server TEST_DATABASE_URL points at and drops it afterwards.
   Skips when TEST_DATABASE_URL is unset, and REFUSES a non-local host: it creates and drops databases. The Prisma
   CLI runs from a temp directory with DATABASE_URL and DIRECT_URL passed explicitly, so it can never fall back to
   the checkout's .env (the shared staging DB).
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { rmSync } from 'fs';
import { dirname, join } from 'path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { DEFAULT_AUTOMATIONS } from '../services/automations/defaultAutomations';
import { deployMigrations, createMigrationDatabase } from './migration-deploy-support';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION = '20261012090000_walkthrough_follow_up_subject_site_visit_finished';
const FOLLOW_UP_KEY = 'default-walkthrough-completed';
const OLD_SUBJECT = 'Site Visit Completed';
const PRISMA_DIR = join(__dirname, '..', '..', 'prisma');
const MIGRATION_SQL = join(PRISMA_DIR, 'migrations', MIGRATION, 'migration.sql');
const PRISMA_CLI = join(dirname(require.resolve('prisma/package.json')), 'build', 'index.js');

function assertLocal(raw: string): URL {
  const u = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) {
    throw new Error(`Follow-up subject migration suite creates and drops databases; refusing non-local host ${u.hostname}`);
  }
  return u;
}

function clientAt(dbUrl: string) {
  return new PrismaClient({ datasources: { db: { url: dbUrl } } });
}
type Db = ReturnType<typeof clientAt>;

suite('walkthrough follow-up subject migration (real database)', () => {
  const server = url ? assertLocal(url) : new URL('postgresql://localhost/unused');
  const admin = clientAt(url ?? '');
  const databases: string[] = [];
  const clients: Db[] = [];
  const tempDirs: string[] = [];

  const registry = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === FOLLOW_UP_KEY)!;
  const NEW_SUBJECT = registry.subject;

  async function createDatabase(): Promise<{ dbUrl: string; client: Db }> {
    const name = `sw0420_mig_${randomUUID().slice(0, 8)}`;
    await createMigrationDatabase(admin, name, MIGRATION, tempDirs);
    databases.push(name);
    const u = new URL(server.toString());
    u.pathname = `/${name}`;
    const dbUrl = u.toString();
    const client = clientAt(dbUrl);
    clients.push(client);
    return { dbUrl, client };
  }

  function cli(dbUrl: string, args: string[], cwd: string) {
    return spawnSync(process.execPath, [PRISMA_CLI, ...args], {
      cwd,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl },
      encoding: 'utf8',
    });
  }

  /** The Prisma deploy command over only the migrations before this one, or through this one and no later (see migration-deploy-support). */
  const deploy = (dbUrl: string, which: 'before' | 'through') => deployMigrations(dbUrl, MIGRATION, which, tempDirs);

  /** The migration file run a second time, the way the shared staging database may see it. */
  function runFileAgain(dbUrl: string, dir: string) {
    return cli(dbUrl, ['db', 'execute', '--url', dbUrl, '--file', MIGRATION_SQL], dir);
  }

  async function organization(db: Db) {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    await db.organization.create({
      data: {
        id, name: `s0420-${tag}`, email: `s0420-${tag}@example.test`, address_line1: '1 Test Way', city: 'Testville',
        state: 'MA', postal_code: '02108', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
      select: { id: true },
    });
    return id;
  }

  const stepConfig = (subject: string) => ({
    recipients: registry.recipients,
    subject,
    body: registry.body,
    fallbacks: { 'customer.first_name': 'there' },
  });

  /** One workflow with its live step and one frozen version per subject given (version n holds subjects[n-1]). */
  async function workflow(
    db: Db,
    org: string,
    opts: { builtinKey: string | null; name: string; trigger?: 'WALKTHROUGH_COMPLETED' | 'WALKTHROUGH_CANCELLED'; live: string; versions: string[] },
  ) {
    const wf = await db.workflow.create({
      data: {
        organization_id: org, name: opts.name, status: 'PUBLISHED', is_enabled: true, builtin_key: opts.builtinKey,
        trigger_type: opts.trigger ?? 'WALKTHROUGH_COMPLETED',
      },
      select: { id: true },
    });
    await db.workflowStep.create({
      data: { workflow_id: wf.id, position: 0, step_type: 'SEND_EMAIL', config: stepConfig(opts.live), organization_id: org },
      select: { id: true },
    });
    for (const [i, subject] of opts.versions.entries()) {
      await db.workflowVersion.create({
        data: {
          workflow_id: wf.id, version: i + 1, organization_id: org,
          definition: {
            trigger_type: opts.trigger ?? 'WALKTHROUGH_COMPLETED', trigger_config: null, send_window: 'ANYTIME',
            steps: [{ position: 0, step_type: 'SEND_EMAIL', config: stepConfig(subject) }],
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    }
    return wf.id;
  }

  const read = async (db: Db, id: string) => {
    const step = await db.workflowStep.findFirstOrThrow({ where: { workflow_id: id }, select: { config: true } });
    const versions = await db.workflowVersion.findMany({
      where: { workflow_id: id }, orderBy: { version: 'asc' }, select: { version: true, definition: true },
    });
    const subjectOf = (c: unknown) => (c as { subject: string }).subject;
    return {
      liveSubject: subjectOf(step.config),
      liveConfig: step.config as Record<string, unknown>,
      versionSubjects: versions.map((v) => subjectOf((v.definition as { steps: { config: unknown }[] }).steps[0].config)),
      versions,
    };
  };

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const c of clients) await quietly(c.$disconnect());
    for (const name of databases) await quietly(admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    await admin.$disconnect();
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  it('gives an unedited copy the registry\'s new subject on the live step and the frozen version, and leaves the rest of the row alone', async () => {
    expect(NEW_SUBJECT).toBe('Site Visit Finished');
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const org = await organization(client);
    const wf = await workflow(client, org, { builtinKey: FOLLOW_UP_KEY, name: 'Walkthrough completed', live: OLD_SUBJECT, versions: [OLD_SUBJECT] });
    const before = await read(client, wf);

    deploy(dbUrl, 'through');

    const after = await read(client, wf);
    expect(after.liveSubject).toBe(NEW_SUBJECT);
    expect(after.versionSubjects).toEqual([NEW_SUBJECT]);
    expect({ ...after.liveConfig, subject: OLD_SUBJECT }).toEqual(before.liveConfig);
    expect(after.versions.map((v) => v.version)).toEqual([1]);
    const frozen = (after.versions[0].definition as { steps: { config: Record<string, unknown> }[] }).steps[0].config;
    expect(frozen.body).toBe(registry.body);
    expect(frozen.recipients).toEqual(registry.recipients);
    expect(frozen.fallbacks).toEqual({ 'customer.first_name': 'there' });
  }, 300_000);

  it('leaves a company\'s edited subject as written, with every one of its versions, older ones included', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const org = await organization(client);
    const edited = 'Thanks for having us out';
    const wf = await workflow(client, org, { builtinKey: FOLLOW_UP_KEY, name: 'Walkthrough completed', live: edited, versions: [OLD_SUBJECT, edited] });
    const before = await read(client, wf);

    deploy(dbUrl, 'through');

    expect(await read(client, wf)).toEqual(before);
  }, 300_000);

  it('touches neither a hand-built automation with the same words nor another built-in, and keeps each company to its own copy', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const orgA = await organization(client);
    const orgB = await organization(client);
    const handBuilt = await workflow(client, orgA, { builtinKey: null, name: 'My own follow-up', live: OLD_SUBJECT, versions: [OLD_SUBJECT] });
    const cancelled = await workflow(client, orgA, {
      builtinKey: 'default-walkthrough-cancelled', name: 'Walkthrough cancelled', trigger: 'WALKTHROUGH_CANCELLED',
      live: 'Site Visit Cancelled', versions: ['Site Visit Cancelled'],
    });
    const followA = await workflow(client, orgA, { builtinKey: FOLLOW_UP_KEY, name: 'Walkthrough completed', live: OLD_SUBJECT, versions: [OLD_SUBJECT] });
    const followB = await workflow(client, orgB, { builtinKey: FOLLOW_UP_KEY, name: 'Walkthrough completed', live: 'Our visit is done', versions: ['Our visit is done'] });
    const before = { handBuilt: await read(client, handBuilt), cancelled: await read(client, cancelled), followB: await read(client, followB) };

    deploy(dbUrl, 'through');

    expect(await read(client, handBuilt)).toEqual(before.handBuilt);
    expect(await read(client, cancelled)).toEqual(before.cancelled);
    expect(await read(client, followB)).toEqual(before.followB);
    expect((await read(client, followA)).liveSubject).toBe(NEW_SUBJECT);
  }, 300_000);

  it('changes nothing when run a second time', async () => {
    const { dbUrl, client } = await createDatabase();
    deploy(dbUrl, 'before');
    const org = await organization(client);
    const wf = await workflow(client, org, { builtinKey: FOLLOW_UP_KEY, name: 'Walkthrough completed', live: OLD_SUBJECT, versions: [OLD_SUBJECT] });

    const dir = deploy(dbUrl, 'through');
    const settled = await read(client, wf);
    const again = runFileAgain(dbUrl, dir);

    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(await read(client, wf)).toEqual(settled);
    expect(settled.liveSubject).toBe(NEW_SUBJECT);
  }, 300_000);
});
