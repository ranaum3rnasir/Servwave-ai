/**
 * Shared scheduler test data seeder.
 *
 * Creates a predictable set of jobs, walkthroughs, and technicians
 * so every scheduler spec starts with a populated board.
 *
 * Usage in spec files:
 *   let seed: ScheduleSeed;
 *   test.beforeAll(async () => { seed = await seedScheduleData(); });
 *   test.afterAll(async () => { await seed.cleanup(); });
 */
import {
  getAdminToken,
  createUrgentJob,
  createTechnicianUser,
  assignJob,
  deleteJob,
  deleteUser,
  getFirstCustomerWithLocation,
  createLeadViaApi,
  markLeadContacted,
  scheduleWalkthrough,
} from './api-helpers';

export interface ScheduleSeed {
  token: string;
  techId1: string;
  techId2: string;
  customerId: string;
  locationId: string;
  /** 3 scheduled jobs for today (9 AM, 11 AM, 2 PM) on tech1 */
  scheduledJobs: Array<{ id: string; job_number: string; hour: number }>;
  /** 1 scheduled job for today (10 AM) on tech2 */
  tech2Job: { id: string; job_number: string };
  /** 2 unassigned jobs (visible in sidebar) */
  unassignedJobs: Array<{ id: string; job_number: string }>;
  /** 1 walkthrough scheduled for today */
  walkthrough: { leadId: string; leadNumber: string };
  /** 1 unscheduled walkthrough (visible in sidebar) */
  unscheduledWalkthrough: { leadId: string; leadNumber: string };
  /** Clean up all created data */
  cleanup: () => Promise<void>;
}

/**
 * Build today's date at a specific hour (local time).
 */
function todayAt(hour: number, durationHrs = 2): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0);
  const end = new Date(start.getTime() + durationHrs * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Seed a full set of scheduler test data.
 * Creates 6 jobs (4 scheduled, 2 unassigned), 2 technicians, 2 walkthroughs.
 * All scheduled events are for TODAY so they appear on the default calendar view.
 */
export async function seedScheduleData(opts?: {
  /** Extra suffix to avoid collisions when running specs in parallel */
  suffix?: string;
}): Promise<ScheduleSeed> {
  const suffix = opts?.suffix ?? Date.now().toString(36);
  const token = await getAdminToken();

  // ── Customer ──
  const customer = await getFirstCustomerWithLocation(token);
  if (!customer) throw new Error('seedScheduleData: no customer with service location found');
  const { customerId, locationId } = customer;

  // ── Technicians ──
  const techId1 = await createTechnicianUser(token, `seed1-${suffix}`);
  const techId2 = await createTechnicianUser(token, `seed2-${suffix}`);

  // ── Scheduled jobs on tech1 (9 AM, 11 AM, 2 PM) ──
  const scheduledJobs: ScheduleSeed['scheduledJobs'] = [];
  for (const hour of [9, 11, 14]) {
    const job = await createUrgentJob(token, customerId, locationId);
    const { start, end } = todayAt(hour);
    await assignJob(token, job.id, techId1, start, end);
    scheduledJobs.push({ id: job.id, job_number: job.job_number, hour });
  }

  // ── Scheduled job on tech2 (10 AM) ──
  const tech2JobRaw = await createUrgentJob(token, customerId, locationId);
  const t2Times = todayAt(10);
  await assignJob(token, tech2JobRaw.id, techId2, t2Times.start, t2Times.end);
  const tech2Job = { id: tech2JobRaw.id, job_number: tech2JobRaw.job_number };

  // ── Unassigned jobs (sidebar) ──
  const unassignedJobs: ScheduleSeed['unassignedJobs'] = [];
  for (let i = 0; i < 2; i++) {
    const job = await createUrgentJob(token, customerId, locationId);
    unassignedJobs.push({ id: job.id, job_number: job.job_number });
  }

  // ── Scheduled walkthrough for today ──
  const wtLead = await createLeadViaApi(token, {
    serviceRequest: `E2E scheduled walkthrough ${suffix}`,
  });
  await markLeadContacted(token, wtLead.id);
  const wtTime = todayAt(13, 1); // 1 PM, 1 hour
  await scheduleWalkthrough(token, wtLead.id, techId1, wtTime.start, 60);
  const walkthrough = { leadId: wtLead.id, leadNumber: wtLead.lead_number };

  // ── Unscheduled walkthrough (sidebar) ──
  const usLead = await createLeadViaApi(token, {
    serviceRequest: `E2E unscheduled walkthrough ${suffix}`,
  });
  await markLeadContacted(token, usLead.id);
  const unscheduledWalkthrough = { leadId: usLead.id, leadNumber: usLead.lead_number };

  // ── Cleanup function ──
  const allJobIds = [
    ...scheduledJobs.map((j) => j.id),
    tech2Job.id,
    ...unassignedJobs.map((j) => j.id),
  ];

  const cleanup = async () => {
    for (const id of allJobIds) await deleteJob(token, id).catch(() => {});
    await deleteUser(token, techId1).catch(() => {});
    await deleteUser(token, techId2).catch(() => {});
    // Leads and customers don't have delete endpoints — left for DB cleanup
  };

  return {
    token,
    techId1,
    techId2,
    customerId,
    locationId,
    scheduledJobs,
    tech2Job,
    unassignedJobs,
    walkthrough,
    unscheduledWalkthrough,
    cleanup,
  };
}
