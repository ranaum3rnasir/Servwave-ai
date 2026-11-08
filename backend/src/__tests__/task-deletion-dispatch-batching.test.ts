/**
 * Deleting many tasks at once enrols their "Task is deleted" runs a few at a time (fix pass, code
 * review #12).
 *
 * A category delete can take 500 tasks. Their bells were already announced ten at a time; their
 * automation runs were not: every dispatch was its own fire-and-forget enrolment, so all 500 started
 * together on the next tick, each opening its own queries against the pool. The runs are enrolled
 * through a bounded lane now, at most as many at once as the bells.
 *
 * The real dispatch module runs here (setup.ts mocks it for every other suite); the enrolment it
 * feeds is the seam, counted for how many are in flight at the same moment.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../services/automations/dispatch', async (importOriginal) => importOriginal());
vi.mock('../services/automations/enrollment', () => ({ enrollOnEvent: vi.fn() }));
vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue([]) }));

import { enrollOnEvent } from '../services/automations/enrollment';
import { announceTaskDeletions, type DeletableTask } from '../lib/tasks/deletion';

const ORG = '00000000-0000-0000-0000-000000000001';
const ACTOR = '00000000-0000-0000-0000-0000000000a1';

describe('announceTaskDeletions - automation runs for a large delete', () => {
  it('never has more than 10 enrolments in flight for a 500-task delete, and enrols every one', async () => {
    let inFlight = 0;
    let most = 0;
    const enrolled: string[] = [];
    vi.mocked(enrollOnEvent).mockImplementation(async (ev) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      enrolled.push(ev.entity.id);
      inFlight -= 1;
    });
    const tasks: DeletableTask[] = Array.from({ length: 500 }, (_, i) => ({
      id: `aa000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `Task ${i}`,
      task_number: `T${String(i).padStart(5, '0')}`,
      assignee_ids: [ACTOR],
      watcher_ids: [],
      created_by: ACTOR,
    }));

    await announceTaskDeletions({ orgId: ORG, actorId: ACTOR }, tasks, []);
    await vi.waitFor(() => expect(enrolled).toHaveLength(500), { timeout: 10_000, interval: 20 });

    expect(most).toBeLessThanOrEqual(10);
    expect(new Set(enrolled).size).toBe(500);
  });

  it('a failed enrolment is swallowed and the rest still enrol', async () => {
    const enrolled: string[] = [];
    vi.mocked(enrollOnEvent).mockImplementation(async (ev) => {
      if (ev.entity.id.endsWith('000000000003')) throw new Error('boom');
      enrolled.push(ev.entity.id);
    });
    const tasks: DeletableTask[] = Array.from({ length: 25 }, (_, i) => ({
      id: `aa000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `Task ${i}`, task_number: `T${i}`, assignee_ids: [], watcher_ids: [], created_by: ACTOR,
    }));

    await announceTaskDeletions({ orgId: ORG, actorId: ACTOR }, tasks, []);
    await vi.waitFor(() => expect(enrolled).toHaveLength(24), { timeout: 5_000, interval: 20 });
  });
});
