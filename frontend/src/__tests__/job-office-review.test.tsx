/**
 * Roles & Permissions, PRD 6, S06.8 - the office review banner and panel on the routed job page.
 *
 * The job's own answer (`job.actions`) offers the review to a holder of Office review while the job is in Office review;
 * the banner and the right-side panel are drawn from the review the server built (`GET /api/jobs/:id/review`). Everyone
 * else sees the status chip and nothing more, and the review is not even asked for.
 *
 * jsdom applies no CSS, so layout is read from the structure and the classes that carry it: the panel's header is
 * outside its one scrolling body, a long group starts collapsed and draws a bounded number of rows, and below md the
 * panel takes the whole screen.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { notificationDeepLink } from '@/components/notifications/notificationDeepLink';
import type { NotificationView } from '@/lib/api/notifications';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { FIRST_ROWS, MORE_ROWS } from '@/components/jobs/review/OfficeReviewPanel';
import type { JobReview, ReviewChoice, ReviewContact, ReviewGroup, ReviewItem } from '@/lib/api/jobReview';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/components/ui/use-toast')>()), toast }));

const JOB_ID = 'j0000000-0000-0000-0000-000000000008';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: JOB_ID }), useNavigate: () => vi.fn() };
});

const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

function mockWidth(belowMd: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MEDIA.belowMd && belowMd,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

const item = (over: Partial<ReviewItem> & { key: string }): ReviewItem => ({
  group: 'lines', kind: 'line', title: `Line: ${over.key}`, summary: 'Unit price $100.00 to $90.00', changes: [],
  by: 'Sam Office', at: '2026-10-03T14:14:00.000Z', checked: false, checked_by: null, checked_at: null,
  unusual: false, unusual_kind: null, unusual_reason: null, latest_entry_id: `e-${over.key}`,
  ...over,
});

/** A customer item as the server builds it (M8): the choices offered by what the entry is, and the one shown. */
const CHOICES_BY_SHAPE: Record<string, { options: ReviewChoice[]; default_choice: ReviewChoice | null }> = {
  'PHONE:ADDED': { options: ['ADD', 'THIS_JOB_ONLY'], default_choice: 'ADD' },
  'PHONE:CHANGED': { options: ['ADD', 'UPDATE', 'THIS_JOB_ONLY'], default_choice: 'ADD' },
  'LAST_NAME:CHANGED': { options: ['THIS_JOB_ONLY', 'UPDATE'], default_choice: 'THIS_JOB_ONLY' },
  'EMAIL:ADDED:removed': { options: [], default_choice: null },
};

function customerItem(over: Partial<ReviewItem> & { key: string; shape?: string; contact?: Partial<ReviewContact> }): ReviewItem {
  const { shape = 'PHONE:ADDED', contact, ...rest } = over;
  const [kind = 'PHONE', intent = 'ADDED', gone] = shape.split(':');
  const removed = gone === 'removed';
  const offered = CHOICES_BY_SHAPE[shape]!;
  return item({
    group: 'customer', kind: 'contact',
    unusual: !removed, unusual_kind: removed ? null : 'customer_change', unusual_reason: removed ? null : 'A customer detail changed',
    ...rest,
    contact: {
      entry_id: `entry-of-${over.key}`, kind, intent, removed, ...offered, decision: null, choice: offered.default_choice, customer_current: null,
      ...contact,
    },
  });
}

const emptyGroups = (): ReviewGroup[] => [
  { key: 'unusual', label: 'Unusual items', items: [] },
  { key: 'customer', label: 'Customer details', items: [] },
  { key: 'lines', label: 'Lines and prices', items: [] },
  { key: 'attachments', label: 'Attachments', items: [] },
  { key: 'notes', label: 'Notes', items: [] },
  { key: 'payments', label: 'Payments', items: [] },
];

/** Put items into their groups, listing the unusual ones in the first group as the server does. */
function withItems(items: ReviewItem[]): ReviewGroup[] {
  return emptyGroups().map((g) => ({
    ...g,
    items: g.key === 'unusual' ? items.filter((i) => i.unusual) : items.filter((i) => i.group === g.key),
  }));
}

function review(over: Partial<JobReview> & { groups?: ReviewGroup[] } = {}): JobReview {
  const groups = over.groups ?? emptyGroups();
  const changes = groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);
  return {
    summary: {
      key: 'summary', title: 'Job details', checked: false, checked_by: null, checked_at: null,
      job_number: 'J00008', job_type: 'Repair',
      customer: { name: 'John Doe', company_name: null },
      service_address: '12 Main St, Springfield, IL 62701',
      visits: [
        { seq: 1, scheduled_at: '2026-10-02T14:00:00.000Z', outcome: 'finished', finished_by: 'Lee Tech', crew: ['Lee Tech'], cancelled_by_complete: false },
        { seq: 2, scheduled_at: '2026-10-03T14:00:00.000Z', outcome: 'cancelled', finished_by: null, crew: [], cancelled_by_complete: true },
      ],
      lines: [{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200 }],
      discount_amount: 10, total: 190,
      invoices: [{ invoice_number: 'INV-1', status: 'SENT', total: 190, amount_due: 190 }],
      balance: 190, file_count: 3, note_count: 2,
    },
    groups,
    version: 'version-1',
    totals: { items: changes.length + 1, checked: changes.filter((i) => i.checked).length, unusual: groups[0]!.items.length },
    round: null,
    ...over,
  };
}

const VISIT = {
  id: `${JOB_ID}-v1`, visit_seq: 1, status: 'COMPLETED', purpose: 'WORK',
  scheduled_at: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', is_all_day: false,
  en_route_at: null, on_site_at: null, started_at: null, completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null,
  customer_email_sent_at: null, notes: null, status_steps: [], assignees: [],
};

/** Shows the address the page is at, so a test can read what the page kept in it. */
function Address() {
  const { pathname, search } = useLocation();
  return <output data-testid="address">{pathname + search}</output>;
}
const address = () => screen.getByTestId('address').textContent;

/** Mount the routed job page. `reviewAnswer` is what the review route returns; `null` makes it fail; `entry` is the address it opens at. */
function mount(over: { job?: Record<string, unknown>; reviewAnswer?: JobReview | null; entry?: string }) {
  const job = {
    id: JOB_ID, job_number: 'J00008', status: 'OFFICE_REVIEW', scope_notes: null, estimated_duration: null, completion_notes: null,
    scheduled_start: '2026-10-02T13:00:00.000Z', scheduled_end: '2026-10-02T15:00:00.000Z', started_at: null,
    completed_at: '2026-10-02T15:00:00.000Z', cancelled_at: null, cancelled_reason: null,
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    customer: { id: 'c1', first_name: 'John', last_name: 'Doe', company_name: null, email: 'j@d.com', phone: '5551234567' },
    assignees: [], visits: [VISIT], service_location: null, estimate: null, invoices: [], linked_estimates: [], tags: [],
    source_plan_id: null, source_plan: null, locked: true, locked_actions: [], actions: ['office_review', 'finish_review'], new_visit_closed_reason: 'Move this job back out of review first',
    ...over.job,
  };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/jobs/${JOB_ID}/review`) {
      if (over.reviewAnswer === null) throw new Error('boom');
      return { data: { review: over.reviewAnswer ?? review() } } as never;
    }
    if (url === `/api/jobs/${JOB_ID}/visits`) return { data: { visits: [VISIT] } } as never;
    if (url.endsWith('/scopes')) return { data: { scopes: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.endsWith('/line-items')) return { data: { lines: [], billing: { total: 0, invoiced: 0, remaining: 0 } } } as never;
    if (url.includes(`/api/jobs/${JOB_ID}`)) return { data: { job } } as never;
    return { data: {} } as never;
  });
  return renderWithProviders(<><JobDetailPage /><Address /></>, { ability, initialEntries: [over.entry ?? '/'] });
}

const reviewCalls = () => mockApi.get.mock.calls.filter(([url]) => String(url).endsWith('/review'));

async function openPanel() {
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Review' }));
  return screen.findByRole('dialog', { name: 'Office review' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWidth(false);
});
afterEach(() => vi.restoreAllMocks());

describe('the office review banner', () => {
  it('shows the item count, the checked count, one chip per kind of unusual item, and the Review button', async () => {
    const items = [
      item({ key: 'l1', unusual: true, unusual_kind: 'price_cut', unusual_reason: 'A price was lowered', checked: true }),
      item({ key: 'l2', unusual: true, unusual_kind: 'price_cut', unusual_reason: 'A line was removed', checked: true }),
      item({ key: 'a1', group: 'attachments', kind: 'attachment', unusual: true, unusual_kind: 'file_deleted', unusual_reason: 'A file was deleted', checked: true }),
      customerItem({ key: 'c1' }),
      item({ key: 'n1', group: 'notes', kind: 'note' }),
      item({ key: 'n2', group: 'notes', kind: 'note' }),
    ];
    mount({ reviewAnswer: review({ groups: withItems(items) }) });
    const banner = await screen.findByRole('region', { name: 'Office review' });
    expect(await within(banner).findByText('Office review · 7 items · 3 checked')).toBeInTheDocument();
    expect(within(banner).getByText('1 file deleted')).toBeInTheDocument();
    expect(within(banner).getByText('2 price cuts')).toBeInTheDocument();
    expect(within(banner).getByText('1 customer change')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Review' })).toBeEnabled();
  });

  it('says "1 item" for a job with no changes, and has no chips', async () => {
    mount({});
    const banner = await screen.findByRole('region', { name: 'Office review' });
    expect(await within(banner).findByText('Office review · 1 item · 0 checked')).toBeInTheDocument();
    expect(within(banner).queryByText(/deleted|price cut|customer change/)).not.toBeInTheDocument();
  });

  it('is not drawn for a person the job does not offer the review to, who sees the status chip and no review is asked for', async () => {
    mount({ job: { actions: ['edit'] } });
    await screen.findByText('J00008');
    expect(screen.getAllByText('Office review').length).toBeGreaterThan(0); // the status chip
    expect(screen.queryByRole('region', { name: 'Office review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
  });

  it('is not drawn once the job has left Office review', async () => {
    mount({ job: { status: 'READY_TO_CLOSE', actions: ['office_review'] } });
    await screen.findByText('J00008');
    expect(screen.queryByRole('region', { name: 'Office review' })).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
  });

  it('says so, and still offers Review, when the review could not be loaded', async () => {
    mount({ reviewAnswer: null });
    const banner = await screen.findByRole('region', { name: 'Office review' });
    expect(await within(banner).findByText('The review could not be loaded.')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Review' })).toBeEnabled();
  });
});

describe('the office review panel', () => {
  it('shows the job summary at the top on a job with no changes, and says nothing changed', async () => {
    mount({});
    const panel = await openPanel();
    const summary = await within(panel).findByRole('region', { name: 'Job details' });
    expect(within(summary).getByText('John Doe')).toBeInTheDocument();
    expect(within(summary).getByText('12 Main St, Springfield, IL 62701')).toBeInTheDocument();
    expect(within(summary).getByText('Repair')).toBeInTheDocument();
    expect(within(summary).getByText(/Visit 1, .*: finished by Lee Tech/)).toBeInTheDocument();
    expect(within(summary).getByText(/Visit 2, .*: cancelled when the job was completed/)).toBeInTheDocument();
    expect(within(summary).getByText('Spring x 2')).toBeInTheDocument();
    expect(within(summary).getByText(', after a $10.00 discount')).toBeInTheDocument();
    expect(within(summary).getByText(/INV-1/)).toBeInTheDocument();
    expect(within(summary).getByText('3 files, 2 notes')).toBeInTheDocument();
    expect(within(panel).getByText(/Nothing was changed on this job/)).toBeInTheDocument();
    // The summary comes before anything else in the body.
    const body = panel.querySelector('[data-slot="sheet-body"]')!;
    expect(body.firstElementChild).toBe(summary);
  });

  it('lists the groups after the summary, the unusual ones first, each item with its words, who and when', async () => {
    const items = [
      item({ key: 'l1', title: 'Line: Spring', summary: 'Unit price $100.00 to $80.00', unusual: true, unusual_kind: 'price_cut', unusual_reason: 'A price was lowered' }),
      item({ key: 'n1', group: 'notes', kind: 'note', title: 'Note', summary: 'Added: Gate code is 1234', by: 'Lee Tech' }),
    ];
    mount({ reviewAnswer: review({ groups: withItems(items) }) });
    const panel = await openPanel();
    const sections = (await within(panel).findAllByRole('region')).map((r) => r.getAttribute('aria-label'));
    expect(sections).toEqual(['Job details', 'Unusual items', 'Lines and prices', 'Notes']);
    const lines = within(panel).getByRole('region', { name: 'Lines and prices' });
    expect(within(lines).getByText('Line: Spring')).toBeInTheDocument();
    expect(within(lines).getByText('Unit price $100.00 to $80.00')).toBeInTheDocument();
    expect(within(lines).getByText('A price was lowered')).toBeInTheDocument();
    expect(within(lines).getByText(/Sam Office, Oct 3/)).toBeInTheDocument();
    expect(within(within(panel).getByRole('region', { name: 'Notes' })).getByText(/Lee Tech, Oct 3/)).toBeInTheDocument();
  });

  it('shows the prices and no cost when the answer carries none', async () => {
    mount({ reviewAnswer: review() });
    const panel = await openPanel();
    const summary = await within(panel).findByRole('region', { name: 'Job details' });
    expect(within(summary).getByText('$200.00')).toBeInTheDocument();
    expect(within(summary).queryByText(/Cost /)).not.toBeInTheDocument();
  });

  it('shows the costs the server sent for a person who may see them', async () => {
    const answer = review();
    answer.summary.lines = [{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200, unit_cost: 60 }];
    answer.summary.total_cost = 120;
    mount({ reviewAnswer: answer });
    const panel = await openPanel();
    expect(within(panel).getByText('Cost $60.00 each')).toBeInTheDocument();
    expect(within(panel).getByText('Cost $120.00')).toBeInTheDocument();
  });

  it('keeps the header pinned outside the one scrolling body', async () => {
    mount({});
    const panel = await openPanel();
    const body = panel.querySelector('[data-slot="sheet-body"]')!;
    const header = panel.querySelector('[data-slot="sheet-header"]')!;
    expect(body.className).toContain('overflow-y-auto');
    expect(header.contains(within(panel).getByText('Office review', { selector: '[data-slot="sheet-title"]' }))).toBe(true);
    expect(body.contains(header)).toBe(false);
    expect(await within(header as HTMLElement).findByText('J00008 · 1 item · 0 checked')).toBeInTheDocument();
  });

  it('takes the whole screen on a phone and is a side panel from md up', async () => {
    mockWidth(true);
    mount({});
    expect((await openPanel()).getAttribute('data-presentation')).toBe('fullscreen');
  });

  it('is a side panel on a desktop', async () => {
    mount({});
    expect((await openPanel()).getAttribute('data-presentation')).toBe('side-sheet');
  });

  it('can be closed', async () => {
    mount({});
    const panel = await openPanel();
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Office review' })).not.toBeInTheDocument();
  });

  it('offers a retry when the review could not be loaded', async () => {
    mount({ reviewAnswer: null });
    const panel = await openPanel();
    expect(await within(panel).findByText('The review could not be loaded.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
});

describe('a review with more than a hundred items', () => {
  const MANY = 140;
  const many = Array.from({ length: MANY }, (_, i) => item({ key: `line-${i}`, title: `Line: Part ${i}` }));

  it('starts a long group collapsed, so the groups under it are not buried, with the counts in the header', async () => {
    const notes = [item({ key: 'n1', group: 'notes', kind: 'note', title: 'Note' })];
    mount({ reviewAnswer: review({ groups: withItems([...many, ...notes]) }) });
    const panel = await openPanel();
    const lines = await within(panel).findByRole('region', { name: 'Lines and prices' });
    const toggle = within(lines).getByRole('button', { name: /Lines and prices/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(lines).queryAllByRole('listitem')).toHaveLength(0);
    // The group after it is still right there, with its row.
    expect(within(within(panel).getByRole('region', { name: 'Notes' })).getByText('Note')).toBeInTheDocument();
    expect(within(panel).getByText(`${MANY + 2} items · 0 checked`, { exact: false })).toBeInTheDocument();
  });

  it('draws a bounded number of rows when the group is opened, and shows more on request', async () => {
    mount({ reviewAnswer: review({ groups: withItems(many) }) });
    const user = userEvent.setup();
    const panel = await openPanel();
    const lines = await within(panel).findByRole('region', { name: 'Lines and prices' });
    await user.click(within(lines).getByRole('button', { name: /Lines and prices/ }));
    expect(within(lines).getAllByRole('listitem')).toHaveLength(FIRST_ROWS);
    await user.click(within(lines).getByRole('button', { name: `Show ${MORE_ROWS} more (${MANY - FIRST_ROWS} left)` }));
    expect(within(lines).getAllByRole('listitem')).toHaveLength(FIRST_ROWS + MORE_ROWS);
    // The job summary is still the first thing in the body, and the header still outside it.
    const body = panel.querySelector('[data-slot="sheet-body"]')!;
    expect(body.firstElementChild).toBe(within(panel).getByRole('region', { name: 'Job details' }));
    expect(body.contains(panel.querySelector('[data-slot="sheet-header"]'))).toBe(false);
  });

  it('collapses an open group again', async () => {
    mount({ reviewAnswer: review({ groups: withItems(many.slice(0, 5)) }) });
    const user = userEvent.setup();
    const panel = await openPanel();
    const lines = await within(panel).findByRole('region', { name: 'Lines and prices' });
    const toggle = within(lines).getByRole('button', { name: /Lines and prices/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(within(lines).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('bounds the summary lists too: 120 lines on the job draw a few and offer the rest', async () => {
    const answer = review();
    answer.summary.lines = Array.from({ length: 120 }, (_, i) => ({ name: `Part ${i}`, quantity: 1, unit_price: 5, line_total: 5 }));
    mount({ reviewAnswer: answer });
    const panel = await openPanel();
    const summary = await within(panel).findByRole('region', { name: 'Job details' });
    expect(within(summary).getAllByText(/^Part \d+ x 1$/)).toHaveLength(8);
    await userEvent.setup().click(within(summary).getByRole('button', { name: 'Show 50 more lines' }));
    expect(within(summary).getAllByText(/^Part \d+ x 1$/)).toHaveLength(58);
  });
});

describe('the checks', () => {
  const lineItem = item({ key: 'line:l1', title: 'Line: Spring', latest_entry_id: 'entry-l1' });
  const noteItem = item({ key: 'note:n1', group: 'notes', kind: 'note', title: 'Note', latest_entry_id: 'entry-n1' });
  const phoneItem = customerItem({ key: 'contact:c1', title: 'Phone 555-1234', summary: 'Phone 555-1234 added for this job only', latest_entry_id: 'entry-c1' });
  const answer = (items: ReviewItem[], summaryChecked = false): JobReview => {
    const base = review({ groups: withItems(items) });
    base.summary.latest_entry_id = 'entry-summary';
    base.summary.checked = summaryChecked;
    base.summary.checked_by = summaryChecked ? 'Sam Office' : null;
    base.totals.checked = items.filter((i) => i.checked).length + (summaryChecked ? 1 : 0);
    return base;
  };
  const postCalls = () => mockApi.post.mock.calls.map(([url, body]) => [url, body]);

  it('checks the job summary with its own button, naming the latest entry, and the banner count follows the stored answer', async () => {
    mount({ reviewAnswer: answer([lineItem]) });
    mockApi.post.mockResolvedValue({ data: { review: answer([lineItem], true) } } as never);
    const panel = await openPanel();
    const summary = await within(panel).findByRole('region', { name: 'Job details' });
    await userEvent.setup().click(within(summary).getByRole('button', { name: 'Check Job details' }));
    expect(postCalls()).toEqual([[`/api/jobs/${JOB_ID}/review/checks`, { item_key: 'summary', entry_id: 'entry-summary' }]]);
    expect(await within(summary).findByText('Checked by Sam Office')).toBeInTheDocument();
    expect(within(summary).queryByRole('button', { name: 'Check Job details' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Office review', hidden: true })).getByText('Office review · 2 items · 1 checked')).toBeInTheDocument();
  });

  it('checks one item with its own button and shows who checked it', async () => {
    mount({ reviewAnswer: answer([lineItem, noteItem]) });
    mockApi.post.mockResolvedValue({ data: { review: answer([{ ...lineItem, checked: true, checked_by: 'Sam Office' }, noteItem]) } } as never);
    const panel = await openPanel();
    const lines = await within(panel).findByRole('region', { name: 'Lines and prices' });
    await userEvent.setup().click(within(lines).getByRole('button', { name: 'Check Line: Spring' }));
    expect(postCalls()).toEqual([[`/api/jobs/${JOB_ID}/review/checks`, { item_key: 'line:l1', entry_id: 'entry-l1' }]]);
    expect(await within(lines).findByText('Checked by Sam Office')).toBeInTheDocument();
    expect(within(lines).queryByRole('button', { name: 'Check Line: Spring' })).not.toBeInTheDocument();
    // The other item is untouched.
    expect(within(within(panel).getByRole('region', { name: 'Notes' })).getByRole('button', { name: 'Check Note' })).toBeEnabled();
  });

  it('gives a customer item no plain Check button: it is ticked through its decision', async () => {
    mount({ reviewAnswer: answer([phoneItem]) });
    const panel = await openPanel();
    const customer = await within(panel).findByRole('region', { name: 'Customer details' });
    expect(within(customer).getByText('Phone 555-1234')).toBeInTheDocument();
    expect(within(customer).queryByRole('button', { name: 'Check Phone 555-1234' })).not.toBeInTheDocument();
  });

  it('sends Mark all checked with the job summary and every unchecked non-customer item, never a customer item, and says customer changes are one by one', async () => {
    const checkedLine = { ...lineItem, key: 'line:done', checked: true, latest_entry_id: 'entry-done' };
    mount({ reviewAnswer: answer([lineItem, noteItem, phoneItem, checkedLine]) });
    mockApi.post.mockResolvedValue({ data: { review: answer([{ ...lineItem, checked: true }, { ...noteItem, checked: true }, phoneItem, checkedLine], true) } } as never);
    const panel = await openPanel();
    const footer = panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(within(footer).getByText('Customer changes are confirmed one by one.')).toBeInTheDocument();
    await userEvent.setup().click(within(footer).getByRole('button', { name: 'Mark all checked' }));
    expect(postCalls()).toEqual([[`/api/jobs/${JOB_ID}/review/checks/all`, {
      items: [
        { item_key: 'summary', entry_id: 'entry-summary' },
        { item_key: 'line:l1', entry_id: 'entry-l1' },
        { item_key: 'note:n1', entry_id: 'entry-n1' },
      ],
    }]]);
    // After it, the customer change is the only thing left, and the line names it.
    expect(await within(footer).findByText('1 left to check: Phone 555-1234.')).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Mark all checked' })).toBeDisabled();
  });

  it('names what is left, and says everything is checked when it is', async () => {
    mount({ reviewAnswer: answer([lineItem, noteItem]) });
    const panel = await openPanel();
    const footer = panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(await within(footer).findByText('3 left to check: Job details, Line: Spring, Note.')).toBeInTheDocument();
  });

  it('keeps the what-is-left line short on a job with 140 unchecked items, and the footer outside the scrolling body', async () => {
    const many = Array.from({ length: 140 }, (_, i) => item({ key: `line:p${i}`, title: `Line: Part number ${i} with a rather long descriptive name`, latest_entry_id: `entry-${i}` }));
    mount({ reviewAnswer: answer(many) });
    const panel = await openPanel();
    const footer = panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    const line = await within(footer).findByText(/left to check/);
    expect(line.textContent).toMatch(/^141 left to check: Job details, Line: Part number 0 with a rath…, Line: Part number 1 with a rath… and 138 more\.$/);
    expect(line.textContent!.length).toBeLessThan(160);
    expect(panel.querySelector('[data-slot="sheet-body"]')!.contains(footer)).toBe(false);
  });

  it('says everything is checked and disables Mark all checked once nothing is left', async () => {
    mount({ reviewAnswer: answer([{ ...lineItem, checked: true }], true) });
    const panel = await openPanel();
    const footer = panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(await within(footer).findByText('Everything is checked.')).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Mark all checked' })).toBeDisabled();
  });

  it('reads the review again and says why when the server refuses a check because the item changed', async () => {
    mount({ reviewAnswer: answer([lineItem]) });
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'Something changed on this item while you were reviewing. Look at the new version and check it again.' } } });
    const panel = await openPanel();
    const lines = await within(panel).findByRole('region', { name: 'Lines and prices' });
    const before = reviewCalls().length;
    await userEvent.setup().click(within(lines).getByRole('button', { name: 'Check Line: Spring' }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Something changed on this item while you were reviewing. Look at the new version and check it again.',
      variant: 'destructive',
    })));
    await vi.waitFor(() => expect(reviewCalls().length).toBeGreaterThan(before));
  });
});

describe('the customer decisions', () => {
  const rowOf = (panel: HTMLElement, title: string | RegExp) => {
    const customer = within(panel).getByRole('region', { name: 'Customer details' });
    return within(customer).getByText(title).closest('li') as HTMLElement;
  };
  const answerWith = (items: ReviewItem[]): JobReview => {
    const base = review({ groups: withItems(items) });
    base.summary.latest_entry_id = 'entry-summary';
    return base;
  };
  const posts = () => mockApi.post.mock.calls.map(([url, body]) => [url, body]);
  const labels = (row: HTMLElement) => within(row).getAllByRole('radio').map((r) => r.textContent);
  const pressed = (row: HTMLElement) => within(row).getAllByRole('radio').filter((r) => r.getAttribute('data-state') === 'on').map((r) => r.textContent);

  const phoneAdded = customerItem({ key: 'contact:p1', title: 'Phone', summary: 'Phone 555-123-4567 added for this job only', latest_entry_id: 'entry-p1' });
  const phoneChanged = customerItem({ key: 'contact:p2', shape: 'PHONE:CHANGED', title: 'Phone', summary: 'Phone 555-000-1111 to 555-222-3333', latest_entry_id: 'entry-p2' });
  const lastName = customerItem({ key: 'contact:n1', shape: 'LAST_NAME:CHANGED', title: 'Last name', summary: 'Last name Doe to Smith', latest_entry_id: 'entry-n1', contact: { customer_current: 'Doe' } });
  const removed = customerItem({ key: 'contact:r1', shape: 'EMAIL:ADDED:removed', title: 'Email', summary: 'Email tenant@example.test: added by Dana Rivera, removed by Sam Office', latest_entry_id: 'entry-r1' });

  it('offers Add to the customer and This job only for an added phone, starting on Add', async () => {
    mount({ reviewAnswer: answerWith([phoneAdded]) });
    const row = rowOf(await openPanel(), 'Phone');
    expect(labels(row)).toEqual(['Add to the customer', 'This job only']);
    expect(pressed(row)).toEqual(['Add to the customer']);
  });

  it('offers all three for a changed phone, starting on Add', async () => {
    mount({ reviewAnswer: answerWith([phoneChanged]) });
    const row = rowOf(await openPanel(), 'Phone');
    expect(labels(row)).toEqual(['Add to the customer', 'Update the customer', 'This job only']);
    expect(pressed(row)).toEqual(['Add to the customer']);
  });

  it('offers This job only and Update the customer for a changed name, starting on This job only, with the customer\'s current value beside the job\'s', async () => {
    mount({ reviewAnswer: answerWith([lastName]) });
    const row = rowOf(await openPanel(), 'Last name');
    expect(labels(row)).toEqual(['This job only', 'Update the customer']);
    expect(pressed(row)).toEqual(['This job only']);
    expect(within(row).getByText("The customer's value now: Doe")).toBeInTheDocument();
    expect(within(row).getByText('Last name Doe to Smith')).toBeInTheDocument();
  });

  it('shows an entry removed before the review with no choice, who added and removed it, and only a check', async () => {
    mount({ reviewAnswer: answerWith([removed]) });
    const row = rowOf(await openPanel(), 'Email');
    expect(within(row).queryAllByRole('radio')).toHaveLength(0);
    expect(within(row).getByText(/added by Dana Rivera, removed by Sam Office/)).toBeInTheDocument();
    expect(within(row).getByText(/Nothing is applied to the customer/)).toBeInTheDocument();
    mockApi.post.mockResolvedValue({ data: { review: answerWith([{ ...removed, checked: true, checked_by: 'Sam Office' }]) } } as never);
    await userEvent.setup().click(within(row).getByRole('button', { name: /^Check Email/ }));
    expect(posts()).toEqual([[`/api/jobs/${JOB_ID}/review/decisions`, { item_key: 'contact:r1', entry_id: 'entry-r1' }]]);
  });

  it('ticks with the default when nothing was picked, and the tick shows who ticked it', async () => {
    mount({ reviewAnswer: answerWith([phoneAdded]) });
    const panel = await openPanel();
    const row = rowOf(panel, 'Phone');
    mockApi.post.mockResolvedValue({ data: { review: answerWith([{ ...phoneAdded, checked: true, checked_by: 'Sam Office', contact: { ...phoneAdded.contact!, decision: 'ADD' } }]) } } as never);
    await userEvent.setup().click(within(row).getByRole('button', { name: /^Check Phone/ }));
    expect(posts()).toEqual([[`/api/jobs/${JOB_ID}/review/decisions`, { item_key: 'contact:p1', entry_id: 'entry-p1', choice: 'ADD' }]]);
    expect(await within(row).findByText('Checked by Sam Office')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /^Check Phone/ })).not.toBeInTheDocument();
    expect(within(row).getByText('Applied to the customer when the review is finished.')).toBeInTheDocument();
  });

  it('ticks with the pick when the reviewer picked, and sends nothing until the tick', async () => {
    mount({ reviewAnswer: answerWith([phoneChanged]) });
    const row = rowOf(await openPanel(), 'Phone');
    const user = userEvent.setup();
    await user.click(within(row).getByRole('radio', { name: 'Update the customer' }));
    expect(pressed(row)).toEqual(['Update the customer']);
    expect(posts()).toEqual([]);
    mockApi.post.mockResolvedValue({ data: { review: answerWith([{ ...phoneChanged, checked: true, checked_by: 'Sam Office', contact: { ...phoneChanged.contact!, decision: 'UPDATE', choice: 'UPDATE' } }]) } } as never);
    await user.click(within(row).getByRole('button', { name: /^Check Phone/ }));
    expect(posts()).toEqual([[`/api/jobs/${JOB_ID}/review/decisions`, { item_key: 'contact:p2', entry_id: 'entry-p2', choice: 'UPDATE' }]]);
  });

  it('keeps a ticked item ticked when the choice is changed, sending the new choice at once', async () => {
    const ticked = { ...phoneChanged, checked: true, checked_by: 'Sam Office', contact: { ...phoneChanged.contact!, decision: 'ADD', choice: 'ADD' as const } };
    mount({ reviewAnswer: answerWith([ticked]) });
    const row = rowOf(await openPanel(), 'Phone');
    mockApi.post.mockResolvedValue({ data: { review: answerWith([{ ...ticked, contact: { ...ticked.contact, decision: 'THIS_JOB_ONLY', choice: 'THIS_JOB_ONLY' as const } }]) } } as never);
    await userEvent.setup().click(within(row).getByRole('radio', { name: 'This job only' }));
    expect(posts()).toEqual([[`/api/jobs/${JOB_ID}/review/decisions`, { item_key: 'contact:p2', entry_id: 'entry-p2', choice: 'THIS_JOB_ONLY' }]]);
    expect(await vi.waitFor(() => pressed(rowOf(screen.getByRole('dialog', { name: 'Office review' }), 'Phone')))).toEqual(['This job only']);
    expect(within(rowOf(screen.getByRole('dialog', { name: 'Office review' }), 'Phone')).getByText('Checked by Sam Office')).toBeInTheDocument();
  });

  it('shows an item whose entry was corrected after the tick as unchecked, with the earlier pick still shown', async () => {
    const corrected = { ...phoneChanged, checked: false, contact: { ...phoneChanged.contact!, decision: 'UPDATE', choice: 'UPDATE' as const } };
    mount({ reviewAnswer: answerWith([corrected]) });
    const row = rowOf(await openPanel(), 'Phone');
    expect(within(row).getByRole('button', { name: /^Check Phone/ })).toBeEnabled();
    expect(pressed(row)).toEqual(['Update the customer']);
  });

  it('counts a ticked customer item in the banner and leaves an unticked one in the what-is-left line', async () => {
    const ticked = { ...phoneAdded, checked: true, checked_by: 'Sam Office' };
    mount({ reviewAnswer: { ...answerWith([ticked, lastName]), totals: { items: 3, checked: 1, unusual: 2 } } });
    const panel = await openPanel();
    const footer = panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(await within(footer).findByText('2 left to check: Job details, Last name.')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Office review', hidden: true })).getByText('Office review · 3 items · 1 checked')).toBeInTheDocument();
  });

  it('shows one choice for an item listed twice, under Unusual items and under Customer details', async () => {
    mount({ reviewAnswer: answerWith([phoneChanged]) });
    const panel = await openPanel();
    const user = userEvent.setup();
    const unusual = within(panel).getByRole('region', { name: 'Unusual items' });
    await user.click(within(unusual).getByRole('radio', { name: 'This job only' }));
    expect(pressed(rowOf(panel, 'Phone'))).toEqual(['This job only']);
    expect(pressed(within(unusual).getByText('Phone').closest('li') as HTMLElement)).toEqual(['This job only']);
  });

  it('pages 25 customer rows at a time and starts a long Customer details group collapsed', async () => {
    const many = Array.from({ length: 60 }, (_, i) => customerItem({ key: `contact:m${i}`, title: `Phone ${i}`, latest_entry_id: `entry-m${i}`, unusual: false, unusual_kind: null, unusual_reason: null }));
    mount({ reviewAnswer: answerWith(many) });
    const user = userEvent.setup();
    const panel = await openPanel();
    const customer = await within(panel).findByRole('region', { name: 'Customer details' });
    const toggle = within(customer).getByRole('button', { name: /Customer details/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(customer).getAllByRole('listitem')).toHaveLength(FIRST_ROWS);
    expect(within(customer).getAllByRole('radiogroup')).toHaveLength(FIRST_ROWS);
  });

  it('lets the choice wrap on a phone: the control is a wrapping group of pills', async () => {
    mockWidth(true);
    mount({ reviewAnswer: answerWith([phoneChanged]) });
    const row = rowOf(await openPanel(), 'Phone');
    const group = within(row).getByRole('radiogroup');
    expect(group.className).toContain('flex-wrap');
  });

  it('says the toast of a refused decision and reads the review again', async () => {
    mount({ reviewAnswer: answerWith([phoneAdded]) });
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: 'Something changed on this item while you were reviewing. Look at the new version and check it again.' } } });
    const row = rowOf(await openPanel(), 'Phone');
    const before = reviewCalls().length;
    await userEvent.setup().click(within(row).getByRole('button', { name: /^Check Phone/ }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't save the decision", variant: 'destructive' })));
    await vi.waitFor(() => expect(reviewCalls().length).toBeGreaterThan(before));
  });
});

describe('finishing the review', () => {
  const STALE = 'Something changed on this job while you were reviewing. Check the new items and finish again.';
  const footerOf = (panel: HTMLElement) => panel.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
  const lineItem = item({ key: 'line:l1', title: 'Line: Spring', latest_entry_id: 'entry-l1' });
  const phoneItem = customerItem({ key: 'contact:p1', title: 'Phone', summary: 'Phone 555-123-4567 added for this job only', latest_entry_id: 'entry-p1' });
  const answerWith = (items: ReviewItem[], summaryChecked: boolean): JobReview => {
    const base = review({ groups: withItems(items) });
    base.summary.latest_entry_id = 'entry-summary';
    base.summary.checked = summaryChecked;
    base.totals.checked = items.filter((i) => i.checked).length + (summaryChecked ? 1 : 0);
    return base;
  };
  const allChecked = () => answerWith([{ ...lineItem, checked: true }, { ...phoneItem, checked: true }], true);
  const posts = () => mockApi.post.mock.calls.map(([url, body]) => [url, body]);

  it('puts Finish review in the pinned footer, disabled and pointing at what is left while the job summary is unchecked', async () => {
    mount({ reviewAnswer: answerWith([{ ...lineItem, checked: true }], false) });
    const footer = footerOf(await openPanel());
    const button = await within(footer).findByRole('button', { name: 'Finish review' });
    expect(button).toBeDisabled();
    const reason = within(footer).getByText('1 left to check: Job details.');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('keeps Finish review disabled while a customer item is unchecked and everything else is checked', async () => {
    mount({ reviewAnswer: answerWith([{ ...lineItem, checked: true }, phoneItem], true) });
    const footer = footerOf(await openPanel());
    expect(await within(footer).findByText('1 left to check: Phone.')).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Finish review' })).toBeDisabled();
  });

  it('enables Finish review once everything is checked, and sends the version of the review it loaded', async () => {
    mount({ reviewAnswer: allChecked() });
    mockApi.post.mockResolvedValue({ data: { status: 'READY_TO_CLOSE', review: allChecked() } } as never);
    const footer = footerOf(await openPanel());
    const button = await within(footer).findByRole('button', { name: 'Finish review' });
    expect(within(footer).getByText('Everything is checked.')).toBeInTheDocument();
    expect(button).toBeEnabled();
    await userEvent.setup().click(button);
    expect(posts()).toEqual([[`/api/jobs/${JOB_ID}/review/finish`, { version: 'version-1' }]]);
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review finished' })));
  });

  it('reads the job again after a finish, so the page follows the new status', async () => {
    mount({ reviewAnswer: allChecked() });
    mockApi.post.mockResolvedValue({ data: { status: 'READY_TO_CLOSE', review: allChecked() } } as never);
    const footer = footerOf(await openPanel());
    const jobReads = () => mockApi.get.mock.calls.filter(([url]) => String(url) === `/api/jobs/${JOB_ID}`).length;
    const before = jobReads();
    await userEvent.setup().click(await within(footer).findByRole('button', { name: 'Finish review' }));
    await vi.waitFor(() => expect(jobReads()).toBeGreaterThan(before));
  });

  it('keeps Finish review working until the job has been read again, so the old Office review counts are never shown beside a finished review', async () => {
    mount({ reviewAnswer: allChecked() });
    mockApi.post.mockResolvedValue({ data: { status: 'READY_TO_CLOSE', review: allChecked() } } as never);
    const panel = await openPanel();
    const footer = footerOf(panel);
    // From the click on, the job read waits until the test lets it land (with the job now Ready to close).
    const answerJob = mockApi.get.getMockImplementation()!;
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    let held = false;
    mockApi.post.mockImplementationOnce(async () => {
      held = true;
      return { data: { status: 'READY_TO_CLOSE', review: allChecked() } } as never;
    });
    mockApi.get.mockImplementation(async (url: string, ...rest: unknown[]) => {
      if (held && url === `/api/jobs/${JOB_ID}`) {
        await landed;
        const fresh = (await answerJob(url, ...rest as [])) as { data: { job: Record<string, unknown> } };
        return { data: { job: { ...fresh.data.job, status: 'READY_TO_CLOSE', actions: [], locked: true } } } as never;
      }
      return answerJob(url, ...rest as []);
    });

    await userEvent.setup().click(await within(footer).findByRole('button', { name: 'Finish review' }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review finished' })));
    // The job has not been read again yet: the panel is still up and its Finish button is working, not enabled.
    expect(screen.getByRole('dialog', { name: 'Office review' })).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: 'Finish review' })).toBeDisabled();

    land();
    await vi.waitFor(() => expect(screen.queryByRole('region', { name: 'Office review' })).not.toBeInTheDocument());
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Office review' })).not.toBeInTheDocument());
  });

  it('never draws the counts the finish answer carries while the job is still being read again: the review shown is the one the person finished', async () => {
    mount({ reviewAnswer: allChecked() });
    const panel = await openPanel();
    const footer = footerOf(panel);
    // An answer whose review reads one item fewer checked than the person finished (the job summary un-checked).
    const odd = answerWith([{ ...lineItem, checked: true }, { ...phoneItem, checked: true }], false);
    const answerJob = mockApi.get.getMockImplementation()!;
    let land: () => void = () => undefined;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    let held = false;
    mockApi.post.mockImplementationOnce(async () => {
      held = true;
      return { data: { status: 'READY_TO_CLOSE', review: odd } } as never;
    });
    mockApi.get.mockImplementation(async (url: string, ...rest: unknown[]) => {
      // Both reads of the job wait: the review too, so the only review in hand is the one the person finished.
      if (held && url === `/api/jobs/${JOB_ID}/review`) await landed;
      if (held && url === `/api/jobs/${JOB_ID}`) {
        await landed;
        const fresh = (await answerJob(url, ...rest as [])) as { data: { job: Record<string, unknown> } };
        return { data: { job: { ...fresh.data.job, status: 'READY_TO_CLOSE', actions: [], locked: true } } } as never;
      }
      return answerJob(url, ...rest as []);
    });

    await userEvent.setup().click(await within(footer).findByRole('button', { name: 'Finish review' }));
    await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Review finished' })));
    expect(screen.queryAllByText(/3 checked/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/2 checked/)).toHaveLength(0);
    expect(within(footer).queryByText(/left to check/)).not.toBeInTheDocument();
    land();
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Office review' })).not.toBeInTheDocument());
  });

  it('shows the stale-version refusal in the panel and reads the review again', async () => {
    mount({ reviewAnswer: allChecked() });
    mockApi.post.mockRejectedValue({ response: { status: 409, data: { error: STALE, code: 'REVIEW_CHANGED' } } });
    const panel = await openPanel();
    const footer = footerOf(panel);
    const before = reviewCalls().length;
    await userEvent.setup().click(await within(footer).findByRole('button', { name: 'Finish review' }));
    expect(await within(footer).findByRole('alert')).toHaveTextContent(STALE);
    await vi.waitFor(() => expect(reviewCalls().length).toBeGreaterThan(before));
    // The refusal stays on screen after the review is read again, until the person does something else.
    expect(within(footer).getByRole('alert')).toHaveTextContent(STALE);
  });

  it('does not offer Finish review to a person whose job answer does not list it', async () => {
    mount({ job: { actions: ['office_review'] }, reviewAnswer: allChecked() });
    const footer = footerOf(await openPanel());
    expect(await within(footer).findByText('Everything is checked.')).toBeInTheDocument();
    expect(within(footer).queryByRole('button', { name: 'Finish review' })).not.toBeInTheDocument();
  });

  it('keeps the footer small and Finish review reachable on a job with 140 unchecked items', async () => {
    const many = Array.from({ length: 140 }, (_, i) => item({ key: `line:p${i}`, title: `Line: Part number ${i} with a rather long descriptive name`, latest_entry_id: `entry-${i}` }));
    mount({ reviewAnswer: answerWith(many, false) });
    const panel = await openPanel();
    const footer = footerOf(panel);
    const button = await within(footer).findByRole('button', { name: 'Finish review' });
    expect(button).toBeDisabled();
    expect(panel.querySelector('[data-slot="sheet-body"]')!.contains(footer)).toBe(false);
    expect(footer.textContent!.length).toBeLessThan(330);
  });
});

// S06.23: a notification names a panel inside its record, and the job page's address carries it, so it can be bookmarked
// and shared. The page opens the named panel on load only when the server's answer for the job lists the review for this
// person; otherwise it is just the job, with no panel, no error and no review fetched.
describe('the review panel in the job page address', () => {
  // The link the bell gives for a job completed alert, as the server writes the alert (its data names the panel).
  const REVIEW_LINK = notificationDeepLink({
    id: 'n1', verb: 'job.completed', category: 'JOB', priority: 'FEED', needs_action: false, object_type: 'JOB', object_id: JOB_ID,
    object_label: 'J00008', title: 'Job completed: J00008 is ready for office review', body: null, data: { panel: 'review' },
    action_type: null, created_at: '2026-10-10T00:00:00Z', seen_at: null, read_at: null, acted_at: null, dismissed_at: null,
  } as NotificationView);

  it('opens the job with the panel already open when the address names it and the job offers the review', async () => {
    mount({ entry: REVIEW_LINK });
    const panel = await screen.findByRole('dialog', { name: 'Office review' });
    expect(await within(panel).findByRole('region', { name: 'Job details' })).toBeInTheDocument();
    expect(address()).toBe(`/jobs/${JOB_ID}?panel=review`);
  });

  it('the Office review attention alert\'s link, as the server writes the alert, opens the job with the panel already open', async () => {
    const attention = notificationDeepLink({
      id: 'n2', verb: 'job.review_attention', category: 'JOB', priority: 'INTERRUPT', needs_action: false, object_type: 'JOB', object_id: JOB_ID,
      object_label: 'J00008', title: 'J00008 needs your attention', body: 'A price was lowered: Line: Door', data: { panel: 'review' },
      action_type: null, created_at: '2026-10-10T00:00:00Z', seen_at: null, read_at: null, acted_at: null, dismissed_at: null,
    } as NotificationView);
    expect(attention).toBe(`/jobs/${JOB_ID}?panel=review`);
    mount({ entry: attention });
    const panel = await screen.findByRole('dialog', { name: 'Office review' });
    expect(await within(panel).findByRole('region', { name: 'Job details' })).toBeInTheDocument();
    expect(address()).toBe(`/jobs/${JOB_ID}?panel=review`);
  });

  it('opens just the job for a viewer whose answer does not list the review: no panel, no error, nothing fetched', async () => {
    mount({ entry: REVIEW_LINK, job: { actions: ['edit'] } });
    expect(await screen.findByText('J00008')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
  });

  it('opens just the job once it has left Office review, even when the viewer holds the review', async () => {
    mount({ entry: REVIEW_LINK, job: { status: 'READY_TO_CLOSE', actions: ['office_review'] } });
    expect(await screen.findByText('J00008')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('ignores a panel name it does not know', async () => {
    mount({ entry: `/jobs/${JOB_ID}?panel=nonsense` });
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens no panel when the address names none', async () => {
    mount({});
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(address()).toBe('/');
  });

  it('puts the panel in the address when it is opened from the banner, so the page can be bookmarked and shared', async () => {
    mount({ entry: `/jobs/${JOB_ID}?tab=notes` });
    await openPanel();
    expect(address()).toBe(`/jobs/${JOB_ID}?tab=notes&panel=review`);
  });

  it('removes the panel from the address when it is closed, and keeps the rest of the address', async () => {
    mount({ entry: `/jobs/${JOB_ID}?tab=notes&panel=review` });
    const panel = await screen.findByRole('dialog', { name: 'Office review' });
    await userEvent.setup().click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(address()).toBe(`/jobs/${JOB_ID}?tab=notes`);
  });
});

describe('the words of the panel', () => {
  const VENDOR_OR_CUSTOMER = /\b(ctm|calltracking|supabase|render|stripe|twilio|resend)\b/i;
  const SOURCES = ['OfficeReviewBanner.tsx', 'OfficeReviewPanel.tsx', 'reviewWording.ts'].map((f) =>
    readFileSync(join(__dirname, '../components/jobs/review', f), 'utf8'),
  );

  it('names no vendor and no customer company in the rendered banner and panel', async () => {
    const items = [
      item({ key: 'l1', unusual: true, unusual_kind: 'price_cut', unusual_reason: 'A line was removed' }),
      item({ key: 'a1', group: 'attachments', kind: 'attachment', unusual: true, unusual_kind: 'file_deleted', unusual_reason: 'A file was deleted' }),
      customerItem({ key: 'c1' }),
    ];
    mount({ reviewAnswer: review({ groups: withItems(items) }) });
    const panel = await openPanel();
    await within(panel).findByRole('region', { name: 'Job details' });
    expect(panel.textContent ?? '').not.toMatch(VENDOR_OR_CUSTOMER);
    expect(screen.getByRole('region', { name: 'Office review', hidden: true }).textContent ?? '').not.toMatch(VENDOR_OR_CUSTOMER);
  });

  it('names no vendor and no customer company in the components own copy', () => {
    // Word-level scan of the strings: the Render-the-service name must never be a word in copy; "render" the verb in code is not copy.
    for (const source of SOURCES) {
      const copy = [...source.matchAll(/'([^'\n]{3,})'|"([^"\n]{3,})"|`([^`\n]{3,})`|>([^<>{}\n]{3,})</g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
      for (const text of copy) expect(text, text).not.toMatch(/\b(ctm|calltracking|supabase|stripe|twilio|resend)\b/i);
    }
  });
});
