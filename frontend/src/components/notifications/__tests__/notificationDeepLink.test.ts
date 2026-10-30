/**
 * Payments go-live slice 32: a payment notification can name where it opens. "A payment could not be
 * applied" is raised on an invoice but its work is in Settings > Payments, so it carries a link path
 * that wins over the object's own page. Anything else keeps opening the object.
 */
import { describe, it, expect } from 'vitest';
import { notificationDeepLink } from '../notificationDeepLink';
import type { NotificationView } from '@/lib/api/notifications';

const item = (over: Partial<NotificationView>): NotificationView => ({
  id: 'n1', verb: 'billing.payment_unrecorded', category: 'BILLING', priority: 'INTERRUPT', needs_action: true,
  object_type: 'INVOICE', object_id: 'inv-1', object_label: 'I0001', title: 't', body: null, data: {},
  action_type: 'VIEW', created_at: '2026-10-10T00:00:00Z', seen_at: null, read_at: null, acted_at: null, dismissed_at: null,
  ...over,
} as NotificationView);

describe('notificationDeepLink: a link path in the notification data', () => {
  it('opens the named page instead of the invoice', () => {
    expect(notificationDeepLink(item({ data: { link_path: '/settings/payments' } }))).toBe('/settings/payments');
  });

  it('works for an organization-level notification too (which otherwise lands on the dashboard)', () => {
    expect(notificationDeepLink(item({ object_type: 'ORGANIZATION', object_id: 'org-1', data: { link_path: '/settings/payments' } }))).toBe('/settings/payments');
    expect(notificationDeepLink(item({ object_type: 'ORGANIZATION', object_id: 'org-1', data: {} }))).toBe('/');
  });

  it('a notification without one still opens its invoice', () => {
    expect(notificationDeepLink(item({ data: {} }))).toBe('/invoices/inv-1');
  });

  it('only an in-app path is followed: an absolute or protocol-relative link is ignored', () => {
    for (const link_path of ['https://example.com/x', '//example.com/x', 'javascript:alert(1)', '']) {
      expect(notificationDeepLink(item({ data: { link_path } })), link_path).toBe('/invoices/inv-1');
    }
  });
});

/**
 * Roles & Permissions S06.23: a notification may name a panel inside its record (`data.panel`). The link is the record's
 * address with the panel in it, the same for everyone; the record's page decides whether this person may see the panel,
 * and a person who may not lands on the record itself.
 */
describe('notificationDeepLink: a panel named in the notification data', () => {
  const job = (data: Record<string, unknown>) => item({ verb: 'job.completed', category: 'JOB', object_type: 'JOB', object_id: 'job-1', data });

  it('opens the job with the review panel named in its address', () => {
    expect(notificationDeepLink(job({ panel: 'review' }))).toBe('/jobs/job-1?panel=review');
  });

  it('a notification that names no panel still opens the job alone', () => {
    expect(notificationDeepLink(job({}))).toBe('/jobs/job-1');
  });

  it('only a plain panel name is followed: anything else leaves the record alone', () => {
    for (const panel of ['', 'Review', 'a&b=c', '../x', 'a b', 7, null, { name: 'review' }]) {
      expect(notificationDeepLink(job({ panel })), String(panel)).toBe('/jobs/job-1');
    }
  });

  it('is general: it rides in any record\'s address, after what the address already carries', () => {
    expect(notificationDeepLink(item({ object_type: 'INVOICE', object_id: 'inv-1', data: { panel: 'payments' } }))).toBe('/invoices/inv-1?panel=payments');
    expect(notificationDeepLink(item({ object_type: 'TASK', object_id: 't-1', data: { panel: 'history' } }))).toBe('/tasks?task=t-1&panel=history');
  });

  it('a named page still wins over the record', () => {
    expect(notificationDeepLink(job({ panel: 'review', link_path: '/settings/payments' }))).toBe('/settings/payments');
  });
});

/** Roles & Permissions S10.19: a reply from an address we didn't send to opens the Needs review item, not the Email page's top. */
describe('notificationDeepLink: a reply from an address we didn\'t send to', () => {
  const reply = (data: Record<string, unknown>) =>
    item({ verb: 'communication.email_inbound', category: 'COMMUNICATION', object_type: 'EMAIL_THREAD', object_id: 'thread-1', data });

  it('opens the held message named in its data', () => {
    expect(notificationDeepLink(reply({ unmatched_reply: true, link_path: '/communication/inbox?review=held-1' }))).toBe('/communication/inbox?review=held-1');
  });

  it('a customer\'s ordinary reply still opens the Email page', () => {
    expect(notificationDeepLink(reply({ subject: 'Re: Quote' }))).toBe('/communication/inbox');
  });
});
