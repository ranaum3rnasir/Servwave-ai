import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { cardCanMissCrew, CLOSED_LEAD_STATUSES } from '../missingCrew';

const SERVER = readFileSync(resolve(__dirname, '../../../../backend/src/lib/missingCrew.ts'), 'utf8');
const LEAD_ORDER = readFileSync(resolve(__dirname, '../../../../backend/src/services/lead-status-options.ts'), 'utf8');

describe('the status half of the Missing crew test, as the card asks it', () => {
  it('leaves out the same job statuses the server does: Cancelled and Completed or later', () => {
    expect(SERVER).toMatch(/status !== 'CANCELLED' && !COMPLETED_OR_LATER_JOB_STATUSES\.includes\(status\)/);
    for (const status of ['CANCELLED', 'COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE']) {
      expect(cardCanMissCrew({ type: 'job', visitStatus: 'SCHEDULED', raw: { status } }), status).toBe(false);
    }
    for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS']) {
      expect(cardCanMissCrew({ type: 'job', visitStatus: 'SCHEDULED', raw: { status } }), status).toBe(true);
    }
  });

  it('closes a lead from Won on, the way the server\'s open list is cut', () => {
    const order = [...(/LEAD_STATUS_ORDER: readonly LeadStatus\[\] = \[([^\]]*)\]/.exec(LEAD_ORDER)?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const closedByServer = order.slice(order.indexOf('WON'));
    for (const status of closedByServer) expect(CLOSED_LEAD_STATUSES, status).toContain(status);
    for (const status of order.slice(0, order.indexOf('WON'))) {
      expect(cardCanMissCrew({ type: 'walkthrough', visitStatus: 'SCHEDULED', raw: { status } }), status).toBe(true);
    }
    expect(cardCanMissCrew({ type: 'walkthrough', visitStatus: 'SCHEDULED', raw: { status: 'WON' } })).toBe(false);
  });

  it.each(['COMPLETED', 'CANCELLED'])('leaves out a %s visit even on an open job', (visitStatus) => {
    expect(cardCanMissCrew({ type: 'job', visitStatus, raw: { status: 'IN_PROGRESS' } })).toBe(false);
  });

  it.each(['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'])('keeps a booked %s visit', (visitStatus) => {
    expect(cardCanMissCrew({ type: 'job', visitStatus, raw: { status: 'SCHEDULED' } })).toBe(true);
  });

  it('reads a card with no status to go on as one that can miss its crew', () => {
    expect(cardCanMissCrew({ type: 'job', raw: {} })).toBe(true);
    expect(cardCanMissCrew({ type: 'walkthrough' })).toBe(true);
  });
});
