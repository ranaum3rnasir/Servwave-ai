import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import { ALL_JOB_ACTIONS } from './helpers';
import { renderJobDetail, serveJobDetail, stubBrowser } from '@/__tests__/harness/jobDetailPage';
import { DetailHeader, DetailDock } from '@/components/detail/DetailHeader';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { buildAbility } from '@/lib/ability';

// Mobile slice 41: the job header on a phone (below sm).

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

stubBrowser();

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
    useNavigate: () => mockNavigate,
  };
});

const originalMatchMedia = window.matchMedia;

/** Pretend to be a phone: only the below-sm query matches. */
function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'John',
    last_name: 'Doe',
    company_name: null,
    email: 'john@doe.com',
    phone: '5551234567',
  },
  assignees: [],
  service_location: null,
  estimate: null,
  invoices: [],
  linked_estimates: [],
  tags: [],
  source_plan_id: null,
  actions: ALL_JOB_ACTIONS,
  source_plan: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  serveJobDetail({
    job: JOB,
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});

describe('job page header at phone width', () => {
  it('has a back control, Complete job in the bottom dock only, and the rest inside Actions', async () => {
    setPhone(true);
    const user = userEvent.setup();
    renderJobDetail({ ability: adminAbility });

    const dock = await screen.findByTestId('detail-dock');
    // Complete job is reachable in the dock, and is the page's only Complete job.
    expect(within(dock).getByRole('button', { name: /Complete job/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Complete job/ })).toHaveLength(1);

    // Back control goes to the jobs list when there is no in-app history.
    await user.click(screen.getByRole('button', { name: 'Back to jobs' }));
    expect(mockNavigate).toHaveBeenCalledWith('/jobs');

    // New Task is no longer a header button; it lives in the Actions menu.
    expect(screen.queryByRole('button', { name: /New Task/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: /New Task/ })).toBeInTheDocument();
  });

  it('keeps the desktop layout from sm up: Complete job and New Task inline, no back control, no dock', async () => {
    setPhone(false);
    renderJobDetail({ ability: adminAbility });

    expect(await screen.findByRole('button', { name: /Complete job/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Task/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to jobs' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-dock')).not.toBeInTheDocument();
  });
});

describe('DetailHeader / DetailDock', () => {
  const actions = [
    { key: 'a', label: 'Alpha', inline: true, onSelect: vi.fn() },
    { key: 'b', label: 'Beta', onSelect: vi.fn() },
  ];

  function header(extra: Partial<React.ComponentProps<typeof DetailHeader>> = {}) {
    return (
      <MemoryRouter>
        <DetailHeader
          backTo="/parent"
          backLabel="Back to parent"
          identity={<span>Record 1</span>}
          meta={<span>Open</span>}
          primary={<button type="button">Do it</button>}
          secondary={actions}
          {...extra}
        />
        <DetailDock>
          <button type="button">Docked</button>
        </DetailDock>
      </MemoryRouter>
    );
  }

  it('stacks on a phone: back control, one primary, one overflow menu holding every secondary action', async () => {
    setPhone(true);
    const user = userEvent.setup();
    render(header());
    expect(screen.getByRole('button', { name: 'Back to parent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toBeInTheDocument();
  });

  it('moves the primary to the dock when asked, and hides the dock while the keyboard is open', () => {
    setPhone(true);
    const vv = Object.assign(new EventTarget(), { height: 700 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: vv });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
    try {
      render(header({ primaryInDockOnPhone: true }));
      expect(screen.queryByRole('button', { name: 'Do it' })).not.toBeInTheDocument();
      // 100px of browser chrome is not a keyboard.
      expect(screen.getByTestId('detail-dock')).toBeInTheDocument();
      act(() => {
        vv.height = 400;
        vv.dispatchEvent(new Event('resize'));
      });
      expect(screen.queryByTestId('detail-dock')).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
    }
  });

  it('shows inline actions beside the menu from sm up and no dock or back control', () => {
    setPhone(false);
    render(header());
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to parent' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('detail-dock')).not.toBeInTheDocument();
  });
});
