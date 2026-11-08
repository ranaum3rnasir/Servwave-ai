import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import WorkflowActivity from './WorkflowActivity';
import { StepTypeTile, STEP_TYPE_META } from './workflow-visuals';
import { useWorkflowActivity, type ActivityRow } from '@/lib/api/workflows';

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useWorkflowActivity: vi.fn() };
});

const mockUseActivity = vi.mocked(useWorkflowActivity);

function queryResult(rows: ActivityRow[] | undefined, overrides: Record<string, unknown> = {}) {
  return { data: rows ? { rows } : undefined, isLoading: false, ...overrides } as ReturnType<typeof useWorkflowActivity>;
}

function makeRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'r1',
    source: 'workflow',
    when: '2026-07-10T09:00:00.000Z',
    step_index: 1,
    step_type: 'SEND_TEXT',
    status: 'SENT',
    recipient_summary: 'Sarah Mitchell',
    detail: 'Texted Sarah Mitchell',
    entity_label: 'J00042',
    audience_outcomes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkflowActivity — rows', () => {
  it('renders the status pill, step fragment, entity label and detail for each row', () => {
    mockUseActivity.mockReturnValue(queryResult([makeRow()]));
    renderWithProviders(<WorkflowActivity id="wf-1" />);

    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Texted Sarah Mitchell')).toBeInTheDocument();
    expect(screen.getByText(/Step 2 · Text the customer/)).toBeInTheDocument();
    expect(screen.getByText(/J00042/)).toBeInTheDocument();
    expect(screen.getByText(/To Sarah Mitchell/)).toBeInTheDocument();
  });

  it('renders all four brief-enumerated statuses with a distinct icon+label pill', () => {
    mockUseActivity.mockReturnValue(
      queryResult([
        makeRow({ id: 'a', status: 'SENT' }),
        makeRow({ id: 'b', status: 'SKIPPED', detail: 'Sarah already left a review' }),
        makeRow({ id: 'c', status: 'FAILED', detail: 'No mobile number on file' }),
        makeRow({ id: 'd', status: 'STOPPED', detail: 'Stopped — the invoice is paid' }),
        makeRow({ id: 'e', status: 'CONTINUED', detail: 'Kept going' }),
      ]),
    );
    renderWithProviders(<WorkflowActivity id="wf-1" />);

    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.getByText('Continued')).toBeInTheDocument();
    expect(screen.getByText('Stopped — the invoice is paid')).toBeInTheDocument();
  });

  it('legacy rows carry the "history" glyph with the previous-engine tooltip', async () => {
    mockUseActivity.mockReturnValue(queryResult([makeRow({ source: 'legacy' })]));
    renderWithProviders(<WorkflowActivity id="wf-1" />);

    expect(screen.getByText('From the previous automations engine')).toBeInTheDocument();
    await userEvent.hover(screen.getByText('From the previous automations engine'));
    // Tooltip content duplicates for a11y (sr-only label + floating tooltip) — assert at least one is visible.
    expect(screen.getAllByText('From the previous automations engine').length).toBeGreaterThan(0);
  });

  it('a workflow-source row renders no legacy glyph', () => {
    mockUseActivity.mockReturnValue(queryResult([makeRow({ source: 'workflow' })]));
    renderWithProviders(<WorkflowActivity id="wf-1" />);
    expect(screen.queryByText('From the previous automations engine')).not.toBeInTheDocument();
  });
});

describe('WorkflowActivity — loading + empty', () => {
  it('shows skeleton rows while loading', () => {
    mockUseActivity.mockReturnValue(queryResult(undefined, { isLoading: true }));
    const { container } = renderWithProviders(<WorkflowActivity id="wf-1" />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows the empty state when there are no rows yet', () => {
    mockUseActivity.mockReturnValue(queryResult([]));
    renderWithProviders(<WorkflowActivity id="wf-1" />);
    expect(screen.getByText(/Nothing has run yet/)).toBeInTheDocument();
  });
});

// The empty state doubles as the "what do I do next?" hint, so it must name the
// step the office actually still owes — telling someone to publish an already
// published automation reads as if the publish silently failed.
describe('WorkflowActivity — the empty state names the remaining step', () => {
  beforeEach(() => mockUseActivity.mockReturnValue(queryResult([])));

  it('a draft is told to publish and turn it on', () => {
    renderWithProviders(<WorkflowActivity id="wf-1" status="DRAFT" isEnabled={false} />);
    expect(screen.getByText(/publish and turn it on to start/i)).toBeInTheDocument();
  });

  it('a published-but-paused automation is told only to turn it on', () => {
    renderWithProviders(<WorkflowActivity id="wf-1" status="PUBLISHED" isEnabled={false} />);
    expect(screen.getByText(/turn it on to start/i)).toBeInTheDocument();
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
  });

  it('a live automation is told it is waiting to fire, not to publish or enable', () => {
    renderWithProviders(<WorkflowActivity id="wf-1" status="PUBLISHED" isEnabled />);
    expect(screen.getByText(/first time it runs/i)).toBeInTheDocument();
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/turn it on/i)).not.toBeInTheDocument();
  });

  it('falls back to the draft wording when status is not yet known', () => {
    renderWithProviders(<WorkflowActivity id={undefined} />);
    expect(screen.getByText(/publish and turn it on to start/i)).toBeInTheDocument();
  });
});

/**
 * The retirement narrows what an admin may AUTHOR, not what history may hold.
 * The Postgres enum keeps the in-app label, so a step run recorded before the
 * retirement is still in the ledger and still has to read as itself. If these
 * two maps ever lose the key, a real past run renders as a bare enum name (or
 * an undefined icon), which is how a retirement quietly corrupts history.
 */
describe('WorkflowActivity - a historical in-app step still renders', () => {
  it('names the retired step in the feed rather than showing its raw type', () => {
    mockUseActivity.mockReturnValue(
      queryResult([
        makeRow({
          source: 'legacy',
          step_index: 0,
          step_type: 'NOTIFY_TEAM',
          detail: 'Notified the dispatcher',
          recipient_summary: undefined,
        }),
      ]),
    );
    renderWithProviders(<WorkflowActivity id="wf-1" />);

    expect(screen.getByText(/Step 1 · Notify the team/)).toBeInTheDocument();
    expect(screen.queryByText(/NOTIFY_TEAM/)).not.toBeInTheDocument();
  });

  it('still has an icon tile for it', () => {
    expect(STEP_TYPE_META.NOTIFY_TEAM.label).toBe('Notify');

    const { container } = renderWithProviders(<StepTypeTile type="NOTIFY_TEAM" />);
    const tile = container.querySelector('[title="Notify"]');
    expect(tile).not.toBeNull();
    expect(tile?.querySelector('svg')).not.toBeNull();
  });
});
