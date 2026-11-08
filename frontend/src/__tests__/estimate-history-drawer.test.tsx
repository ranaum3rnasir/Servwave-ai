/**
 * #2030 slice 4 — the history drawer shows versions alongside activity events.
 *
 * The flat list of "this field was edited" never answered the question anyone actually asks,
 * which is *what did the customer get?* The versions are the anchors that answer it, so they read
 * as heavier, clickable rows among the lighter event rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { HistoryPanel } from '@/features/estimate-workspace/components/HistoryPanel';

const ESTIMATE_ID = 'est-1';

const EVENTS = [
  { id: 'e-3', action: 'estimate.updated', actor_email: 'rep@example.test', created_at: '2026-03-02T12:00:00Z' },
  { id: 'e-2', action: 'estimate.sent', actor_email: 'rep@example.test', created_at: '2026-02-01T12:00:00Z' },
  { id: 'e-1', action: 'estimate.created', actor_email: 'rep@example.test', created_at: '2026-01-02T12:00:00Z' },
];

const VERSIONS = [
  { id: 'snap-1', version: 1, trigger: 'SEND', total_amount: '1000.00', sent_at: '2026-02-01T12:00:00Z' },
  { id: 'snap-2', version: 2, trigger: 'MARK_SENT', total_amount: '2500.00', sent_at: '2026-04-05T12:00:00Z' },
];

function mockApi({ events = EVENTS, versions = VERSIONS }: { events?: unknown[]; versions?: unknown[] } = {}) {
  vi.mocked(api.get).mockImplementation((url: string) => {
    if (url.endsWith('/history')) return Promise.resolve({ data: { events } } as never);
    if (url.endsWith('/versions')) return Promise.resolve({ data: { versions } } as never);
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
});

function open() {
  return renderWithProviders(<HistoryPanel open onClose={() => {}} estimateId={ESTIMATE_ID} />);
}

describe('the history drawer', () => {
  it('shows the versions and the activity events in one list, newest first', async () => {
    open();

    await screen.findByText('Version 2');
    const rows = screen.getAllByRole('listitem');

    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Version 2'),
      expect.stringContaining('Estimate updated'),
      expect.stringContaining('Version 1'),
      expect.stringContaining('Sent to customer'),
      expect.stringContaining('Estimate created'),
    ]);
  });
});

describe('a version row', () => {
  it('opens the read-only view of that version', async () => {
    open();

    const link = await screen.findByRole('link', { name: /Version 2/ });

    expect(link).toHaveAttribute('href', '/estimates/est-1/versions/2');
    expect(screen.getByRole('link', { name: /Version 1/ })).toHaveAttribute(
      'href',
      '/estimates/est-1/versions/1',
    );
  });

  it('shows its OWN send date, not another version’s', async () => {
    open();

    const link = await screen.findByRole('link', { name: /Version 2/ });
    const when = (iso: string) =>
      new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

    expect(link).toHaveTextContent(when('2026-04-05T12:00:00Z'));
    expect(link).not.toHaveTextContent(when('2026-02-01T12:00:00Z'));
  });

  it('says how it reached the customer, in words rather than an enum value', async () => {
    open();

    expect(await screen.findByRole('link', { name: /Version 2/ })).toHaveTextContent('Marked as sent');
    expect(screen.getByRole('link', { name: /Version 1/ })).toHaveTextContent('Emailed to the customer');
    expect(screen.queryByText(/MARK_SENT|SEND/)).not.toBeInTheDocument();
  });

  it('shows what the customer was quoted, which is the question the drawer exists to answer', async () => {
    open();

    expect(await screen.findByRole('link', { name: /Version 2/ })).toHaveTextContent('$2,500.00');
  });

  /**
   * "Versions are visually distinct from events" was pinned only by the fact that versions are
   * links, which survives restyling a version card to look exactly like an event row. The
   * distinction is the point of the merged drawer — the versions are the ANCHORS a reader is
   * scanning for — so the card's anchor treatment is asserted directly: a tinted, bordered card,
   * against the event row's flat bottom rule.
   */
  it('reads as an anchor card, not as another flat event row', async () => {
    open();

    const card = await screen.findByRole('link', { name: /Version 2/ });
    expect(card).toHaveClass('rounded-card', 'border', 'bg-primary-subtle');

    const eventRow = screen.getByText('Estimate updated').closest('li');
    expect(eventRow).not.toHaveClass('bg-primary-subtle');
    expect(eventRow).toHaveClass('border-b');
  });

  it('is the only kind of row that is clickable — events stay flat detail', async () => {
    open();
    await screen.findByText('Version 2');

    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(2);
    expect(screen.getByText('Estimate updated').closest('a')).toBeNull();
  });
});

/**
 * Rows minted before the ordinal became the snapshot's own can still share a version number. Both
 * are real deliveries and both belong in the drawer; what must not happen is React seeing one key
 * for two children and reusing a node between them.
 */
describe('two legacy snapshots that share a version number', () => {
  const DUPLICATES = [
    { id: 'snap-a', version: 1, trigger: 'SEND', total_amount: '1000.00', sent_at: '2026-02-01T12:00:00Z' },
    { id: 'snap-b', version: 1, trigger: 'COPY_TO_INVOICE', total_amount: '1000.00', sent_at: '2026-02-03T12:00:00Z' },
  ];

  it('renders both of them, each on its own key', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi({ events: [], versions: DUPLICATES });
    open();

    const links = await screen.findAllByRole('link', { name: /Version 1/ });

    expect(links).toHaveLength(2);
    // Newest first, and each card carries its OWN delivery — not one card rendered twice.
    expect(links[0]).toHaveTextContent('Copied to an invoice');
    expect(links[1]).toHaveTextContent('Emailed to the customer');
    // React collapses nothing and warns about nothing: the key is the snapshot id.
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });
});

/**
 * `sent_at` is NOT NULL in the schema, so this is unreachable through the current endpoint — but
 * the merge function already guards null when it reads the same field for ordering, and two
 * helpers reading one value must not disagree about whether null is possible. Ungarded,
 * `new Date(null).getTime()` is 0, not NaN, so the card would state a send date of Dec 31 1969.
 */
describe('a version whose send date is missing', () => {
  it('says nothing about when, rather than inventing 1969', async () => {
    mockApi({
      events: [],
      versions: [{ id: 'snap-1', version: 1, trigger: 'SEND', total_amount: '1000.00', sent_at: null }],
    });
    open();

    const card = await screen.findByRole('link', { name: /Version 1/ });

    expect(card.querySelector('p')?.textContent).toBe('Emailed to the customer');
  });
});

describe('an estimate that has no versions to show', () => {
  it('shows its events and no versions when it was sent before versioning shipped', async () => {
    mockApi({ versions: [] });
    open();

    expect(await screen.findByText('Estimate updated')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
  });

  it('still shows its events when the versions cannot be loaded at all', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/history')) return Promise.resolve({ data: { events: EVENTS } } as never);
      return Promise.reject({ response: { status: 404, data: { error: 'Estimate not found' } } });
    });
    open();

    expect(await screen.findByText('Estimate updated')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByText('No activity recorded yet.')).not.toBeInTheDocument();
  });

  it('says nothing has happened only when BOTH streams are empty', async () => {
    mockApi({ events: [], versions: [] });
    open();

    expect(await screen.findByText('No activity recorded yet.')).toBeInTheDocument();
  });
});

describe('an estimate whose only history is its sends', () => {
  it('renders the versions with no events between them', async () => {
    mockApi({ events: [] });
    open();

    await screen.findByText('Version 2');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('No activity recorded yet.')).not.toBeInTheDocument();
  });
});

/**
 * One drawer, so ONE wait. Dropping the versions query from the loading flag let the events paint
 * first and the versions drop in on top of them a moment later — the list a reader is scanning
 * reorders under their eyes, and the version they were reaching for moves.
 */
describe('while one stream is still in flight', () => {
  it('holds the skeleton until BOTH have answered', async () => {
    let releaseVersions: (value: unknown) => void = () => {};
    const versionsPending = new Promise((resolve) => {
      releaseVersions = resolve;
    });
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/history')) return Promise.resolve({ data: { events: EVENTS } } as never);
      if (url.endsWith('/versions')) return versionsPending as never;
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    open();

    // The activity stream has answered by now; the versions have not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText('Estimate updated')).not.toBeInTheDocument();
    expect(screen.queryByText('No activity recorded yet.')).not.toBeInTheDocument();

    releaseVersions({ data: { versions: VERSIONS } });

    // …and when they do, the merged list arrives in one piece rather than reordering itself.
    await waitFor(() => expect(screen.getByText('Version 2')).toBeInTheDocument());
    expect(screen.getByText('Estimate updated')).toBeInTheDocument();
    expect(document.querySelectorAll('.animate-pulse')).toHaveLength(0);
  });
});

/**
 * #2091 — QA on staging found rows rendering literally as `estimate.line_added`,
 * `estimate.line_updated`, `estimate.scope_added` and `estimate.deposit_repriced`: real backend
 * actions `ACTION_LABELS` had never been taught to name.
 */
describe('an event whose action the backend recently added', () => {
  it('labels the four actions QA found rendering as raw event codes', async () => {
    mockApi({
      events: [
        { id: 'e-4', action: 'estimate.line_added', actor_email: 'rep@example.test', created_at: '2026-03-04T12:00:00Z' },
        { id: 'e-3', action: 'estimate.line_updated', actor_email: 'rep@example.test', created_at: '2026-03-03T12:00:00Z' },
        { id: 'e-2', action: 'estimate.scope_added', actor_email: 'rep@example.test', created_at: '2026-03-02T12:00:00Z' },
        { id: 'e-1', action: 'estimate.deposit_repriced', actor_email: 'rep@example.test', created_at: '2026-03-01T12:00:00Z' },
      ],
      versions: [],
    });
    open();

    expect(await screen.findByText('Line item added')).toBeInTheDocument();
    expect(screen.getByText('Line item updated')).toBeInTheDocument();
    expect(screen.getByText('Scope of work added')).toBeInTheDocument();
    expect(screen.getByText('Deposit amount updated')).toBeInTheDocument();
    expect(screen.queryByText(/^estimate\./)).not.toBeInTheDocument();
  });

  it('falls back to a plain-English label, never the raw dotted key, for an action nobody named yet', async () => {
    mockApi({
      events: [
        { id: 'e-1', action: 'estimate.not_yet_labelled', actor_email: 'rep@example.test', created_at: '2026-03-01T12:00:00Z' },
      ],
      versions: [],
    });
    open();

    expect(await screen.findByText('Estimate activity')).toBeInTheDocument();
    expect(screen.queryByText('estimate.not_yet_labelled')).not.toBeInTheDocument();
    expect(screen.getByText('Estimate activity')).toHaveAttribute('title', 'estimate.not_yet_labelled');
  });
});

describe('the activity query', () => {
  it('is unchanged — same endpoint, no params, one call', async () => {
    open();
    await screen.findByText('Version 2');

    const historyCalls = vi.mocked(api.get).mock.calls.filter(([url]) => String(url).endsWith('/history'));
    expect(historyCalls).toEqual([['/api/estimates/est-1/history']]);
  });

  it('asks for the versions on their own endpoint', async () => {
    open();
    await screen.findByText('Version 2');

    expect(api.get).toHaveBeenCalledWith('/api/estimates/est-1/versions');
  });
});
