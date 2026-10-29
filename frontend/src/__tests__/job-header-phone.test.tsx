import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { render } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { DetailHeader, DetailDock } from '@/components/detail/DetailHeader';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { buildAbility } from '@/lib/ability';

// Mobile slice 41: the job header on a phone (below sm).

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

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
const mockApi = vi.mocked(api);

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
  source_plan: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/jobs/')) return { data: { job: JOB } };
    return { data: {} };
  });
});

afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});

describe('job page header at phone width', () => {
  it('has a back control, Mark Complete in the bottom dock only, and the rest inside Actions', async () => {
    setPhone(true);
    const user = userEvent.setup();
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    const dock = await screen.findByTestId('detail-dock');
    // Mark Complete is reachable in the dock, and is the page's only Mark Complete.
    expect(within(dock).getByRole('button', { name: /Mark Complete/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Mark Complete/ })).toHaveLength(1);

    // Back control goes to the jobs list when there is no in-app history.
    await user.click(screen.getByRole('button', { name: 'Back to jobs' }));
    expect(mockNavigate).toHaveBeenCalledWith('/jobs');

    // New Task is no longer a header button; it lives in the Actions menu.
    expect(screen.queryByRole('button', { name: /New Task/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: /New Task/ })).toBeInTheDocument();
  });

  it('keeps the desktop layout from sm up: Mark Complete and New Task inline, no back control, no dock', async () => {
    setPhone(false);
    renderWithProviders(<JobDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /Mark Complete/ })).toBeInTheDocument();
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
