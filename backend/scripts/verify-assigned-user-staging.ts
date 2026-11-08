#!/usr/bin/env tsx
/**
 * Read-only staging check for the assigned_user audience (Phase 3 cutover).
 *
 * TECH_ASSIGNED / WALKTHROUGH_PERFORMER_ASSIGNED dispatch once per NEWLY-ADDED
 * person. `assigned_team` resolves to the whole live crew, so a default seeded
 * with it would re-email everyone already on the job each time one more person
 * joined. `assigned_user` reads the individual the event captured instead.
 *
 * This drives the real loadExecutionBundle + resolveAudience against a real
 * staging job. It writes nothing and sends nothing.
 *
 *   npx tsx scripts/verify-assigned-user-staging.ts <jobId>
 */
import { prisma } from '../src/lib/prisma';
import { loadExecutionBundle } from '../src/services/automations/context';
import { resolveAudience } from '../src/services/automations/recipients';

const label = (u: { first_name: string | null; last_name: string | null; email: string | null }) =>
  `${[u.first_name, u.last_name].filter(Boolean).join(' ')} <${u.email}>`;

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) throw new Error('usage: verify-assigned-user-staging.ts <jobId>');

  const job = await prisma.job.findUniqueOrThrow({
    where: { id: jobId },
    select: { id: true, job_number: true, organization_id: true },
  });

  const loaded = await loadExecutionBundle({
    organizationId: job.organization_id,
    entityType: 'job',
    entityId: job.id,
    entityLabel: job.job_number,
    dedupeKey: `verify-assigned-user:${job.id}`,
  });
  if (!loaded) throw new Error('loadExecutionBundle returned null');

  const ctx = loaded.bundle;
  console.log(`Job ${job.job_number} — live crew (${ctx.assignees.length}):`);
  ctx.assignees.forEach((u) => console.log(`   • ${label(u)}`));

  // The person a single TECH_ASSIGNED dispatch is about.
  const newlyAdded = ctx.assignees[ctx.assignees.length - 1];

  const team = await resolveAudience('assigned_team', ctx);
  const user = await resolveAudience('assigned_user', { ...ctx, eventRecipient: newlyAdded });

  console.log(`\nassigned_team  → ${team.users.length} recipient(s)`);
  team.users.forEach((u) => console.log(`   • ${label(u)}`));
  console.log(`assigned_user  → ${user.users.length} recipient(s)  [event captured: ${label(newlyAdded)}]`);
  user.users.forEach((u) => console.log(`   • ${label(u)}`));

  const onlyTheAddedPerson = user.users.length === 1 && user.users[0].id === newlyAdded.id;
  const teamWouldOverSend = team.users.length > 1;
  console.log(
    `\nassigned_user addresses exactly the added person: ${onlyTheAddedPerson ? 'PASS' : 'FAIL'}`,
  );
  console.log(
    `assigned_team would have emailed ${team.users.length} people for one addition: ${
      teamWouldOverSend ? `CONFIRMED over-send (${team.users.length - 1} spurious)` : 'n/a (crew of 1)'
    }`,
  );

  // What the seeded staging rows actually point at.
  const seeded = await prisma.workflow.findMany({
    where: {
      organization_id: job.organization_id,
      builtin_key: { in: ['default-tech-assigned', 'default-walkthrough-performer-assigned'] },
    },
    select: { builtin_key: true, is_enabled: true, status: true, steps: { select: { config: true } } },
  });
  console.log('\nSeeded rows in this org:');
  for (const w of seeded) {
    const recipients = (w.steps[0]?.config as { recipients?: string[] })?.recipients;
    console.log(`   ${w.builtin_key}: ${w.status} enabled=${w.is_enabled} recipients=${JSON.stringify(recipients)}`);
  }

  if (!onlyTheAddedPerson) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('FAILED:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
