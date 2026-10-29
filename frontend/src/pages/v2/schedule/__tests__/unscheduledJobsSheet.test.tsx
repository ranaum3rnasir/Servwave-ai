/**
 * Mobile slice 70 - schedule an unscheduled job by tap on phones and tablets.
 *
 * Below lg (1024 px) the unscheduled-jobs bucket and the search panel are not a side column: they
 * open as a sheet from a toolbar button, and tapping a job opens the scheduling form (date, time,
 * crew). Native drag never starts on iOS, so this is the touch path. At lg and up the side panel
 * stays. A panel that is not showing is NOT mounted (the DOM-size half of PERF-04).
 *
 * jsdom has no layout, so the DOM-node budget and the real touch path are measured in the mobile
 * gate (e2e/mobile/scheduler-unscheduled-sheet.spec.ts). What jsdom CAN pin is which surface is
 * mounted where, and that a tap on a card in the sheet ends in the same assign request a drop makes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// usePlanMode reads its storage key off a per-tab id at MODULE LOAD, so it has to exist before
// SchedulePage (and through it the hook) is imported.
vi.hoisted(() => sessionStorage.setItem('plan-mode-tab-id', 'm70-sheet-test'));

import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';

import SchedulePage from '../SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);

/** Evaluate width and height media queries at the simulated viewport. */
function matchesAt(query: string, width: number, height: number): boolean {
  const parts = query.match(/\((min|max)-(width|height):\s*([\d.]+)px\)/g) ?? [];
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const [, kind, axis, px] = part.match(/\((min|max)-(width|height):\s*([\d.]+)px\)/) ?? [];
    const actual = axis === 'width' ? width : height;
    return kind === 'min' ? actual >= Number(px) : actual <= Number(px);
  });
}

const originalMatchMedia = window.matchMedia;

function setViewport(width: number, height = 800) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matchesAt(query, width, height),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const PHONE = 393;
const TABLET = 768;
const DESKTOP = 1280;

const BUCKET_JOB = {
  id: 'job-bucket-1',
  job_number: 'J00043',
  title: 'Rooftop Unit Swap',
  status: 'UNSCHEDULED',
  customer: { id: 'c1', first_name: 'Acme', last_name: 'Corp' },
  scheduled_start: null,
  scheduled_end: null,
  assignees: [],
  visits: [],
};

function mockBoard() {
  mockApi.get.mockImplementation((url: string, config?: { params?: unknown }) => {
    if (url === '/api/jobs') {
      const status = (config?.params as { status?: unknown } | undefined)?.status;
      const wantsBucket = status === 'UNSCHEDULED'
        || (Array.isArray(status) && status.includes('UNSCHEDULED'));
      return Promise.resolve({ data: { jobs: wantsBucket ? [BUCKET_JOB] : [] } });
    }
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/organization') return Promise.resolve({ data: {} });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    if (url === '/api/calendar-entries') return Promise.resolve({ data: { calendar_entries: [] } });
    return Promise.resolve({ data: {} });
  });
  mockApi.post.mockResolvedValue({ data: {} });
}

async function renderBoard() {
  const utils = renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN, initialEntries: ['/schedule'] },
  );
  await waitFor(() => expect(utils.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
  return utils;
}

/** The toolbar's own entry to the sheet: a row button on a tablet, a button in More on a phone. */
async function openSheet(compact: boolean) {
  if (compact) {
    fireEvent.click(screen.getByRole('button', { name: 'More schedule options' }));
    const options = await screen.findByRole('dialog', { name: 'Schedule options' });
    fireEvent.click(within(options).getByRole('button', { name: /^Unscheduled jobs/ }));
  } else {
    fireEvent.click(screen.getByRole('button', { name: /^Unscheduled jobs/ }));
  }
  return screen.findByRole('dialog', { name: 'Unscheduled jobs' });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  mockBoard();
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('the unscheduled-jobs panel below lg', () => {
  it('is not mounted on a phone, and the sheet is opened from the More options', async () => {
    setViewport(PHONE);
    await renderBoard();

    // Not hidden by CSS: absent. A panel that is not showing costs no DOM.
    expect(screen.queryByTestId('unassigned-buckets')).toBeNull();
    expect(screen.queryByPlaceholderText('Search schedule...')).toBeNull();

    const sheet = await openSheet(true);
    expect(within(sheet).getByTestId('unassigned-buckets')).toBeInTheDocument();
    expect(await within(sheet).findByText('J00043')).toBeInTheDocument();
    expect(within(sheet).getByPlaceholderText('Search schedule...')).toBeInTheDocument();
  });

  it('is not mounted on a phone held sideways (wide but short), and opens the same sheet', async () => {
    setViewport(838, 390);
    await renderBoard();
    expect(screen.queryByTestId('unassigned-buckets')).toBeNull();
    const sheet = await openSheet(true);
    expect(await within(sheet).findByText('J00043')).toBeInTheDocument();
  });

  it('is not mounted on a tablet, and the desktop toolbar carries its own button', async () => {
    setViewport(TABLET, 1024);
    await renderBoard();

    expect(screen.queryByTestId('unassigned-buckets')).toBeNull();
    // The count is on the button, so the dispatcher sees there is work before opening anything.
    const button = await screen.findByRole('button', { name: 'Unscheduled jobs, 1' });
    expect(button).toBeInTheDocument();

    const sheet = await openSheet(false);
    expect(await within(sheet).findByText('J00043')).toBeInTheDocument();
  });

  it('keeps the side panel at lg and up, with no toolbar button for it', async () => {
    setViewport(DESKTOP, 900);
    await renderBoard();

    expect(screen.getByTestId('unassigned-buckets')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Unscheduled jobs/ })).toBeNull();
    // Desktop still drags: the card is a drag source.
    const card = (await screen.findByText('J00043')).closest('[draggable]');
    expect(card).toHaveAttribute('draggable', 'true');
  });

  it('does not mount the side panel while it is collapsed at lg and up', async () => {
    setViewport(DESKTOP, 900);
    await renderBoard();
    expect(screen.getByTestId('unassigned-buckets')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));

    await waitFor(() => expect(screen.queryByTestId('unassigned-buckets')).toBeNull());
    expect(screen.getByRole('button', { name: 'Open panel' })).toBeInTheDocument();
  });
});

describe('scheduling a job from the sheet by tap', () => {
  it('opens the scheduling form for the tapped job, with date, time and crew', async () => {
    setViewport(PHONE);
    await renderBoard();
    const sheet = await openSheet(true);

    // Cards in the sheet are tapped, not dragged.
    const card = (await within(sheet).findByText('J00043')).closest('div[class*="rounded-lg"]') as HTMLElement;
    expect(card).toHaveAttribute('draggable', 'false');
    expect(within(sheet).queryByText(/Drag a board card back here/)).toBeNull();

    fireEvent.click(card);

    const form = await screen.findByRole('dialog', { name: /Schedule .* Acme Corp/ });
    expect(screen.queryByRole('dialog', { name: 'Unscheduled jobs' }), 'the sheet gives way to the form').toBeNull();
    expect(within(form).getByText('Start date')).toBeInTheDocument();
    expect(within(form).getByText('Start time')).toBeInTheDocument();
    expect(within(form).getByText('Crew')).toBeInTheDocument();
    // Nothing was dropped, so the form must not claim its fields were filled from a drop.
    expect(within(form).queryByText(/auto-filled from where you dropped/)).toBeNull();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('Schedule sends the same assign request a drop would, and the job leaves the sheet', async () => {
    setViewport(PHONE);
    await renderBoard();
    const sheet = await openSheet(true);
    fireEvent.click((await within(sheet).findByText('J00043')).closest('div[class*="rounded-lg"]') as HTMLElement);

    const form = await screen.findByRole('dialog', { name: /Schedule .* Acme Corp/ });
    fireEvent.click(within(form).getByRole('button', { name: 'Schedule' }));
    // An admin with an empty crew is asked once; the answer is the deliberate "needs crew".
    fireEvent.click(await screen.findByRole('button', { name: 'Schedule anyway' }));

    await waitFor(() => {
      const call = mockApi.post.mock.calls.find(([url]) => url === '/api/jobs/job-bucket-1/assign');
      expect(call, 'the assign request').toBeTruthy();
      const body = call![1] as { assignee_ids: string[]; scheduled_start: string; scheduled_end: string };
      expect(body.assignee_ids).toEqual([]);
      expect(new Date(body.scheduled_end).getTime() - new Date(body.scheduled_start).getTime()).toBeGreaterThan(0);
    });
  });

  it('in Plan Mode a tapped card becomes a draft on the plan and saves nothing', async () => {
    setViewport(PHONE);
    localStorage.setItem(
      'plan-mode-m70-sheet-test',
      JSON.stringify({ isActive: true, ghosts: [], updatedAt: Date.now() }),
    );
    await renderBoard();
    const sheet = await openSheet(true);
    fireEvent.click((await within(sheet).findByText('J00043')).closest('div[class*="rounded-lg"]') as HTMLElement);

    const form = await screen.findByRole('dialog', { name: /Schedule .* Acme Corp/ });
    // A draft needs no crew, so there is no "nobody is assigned" warning in the way.
    fireEvent.click(within(form).getByRole('button', { name: 'Schedule' }));

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('plan-mode-m70-sheet-test') ?? '{}') as {
        ghosts?: Array<{ sourceId: string; sourceType: string; isFromSidebar: boolean }>;
      };
      expect(saved.ghosts).toHaveLength(1);
      expect(saved.ghosts![0]).toMatchObject({ sourceId: 'job-bucket-1', sourceType: 'job', isFromSidebar: true });
    });
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('a viewer who cannot change the board still gets the read-only editor, not a scheduling form', async () => {
    setViewport(PHONE);
    // `boardCapabilitiesFor` reads the signed-in ROLE: a technician's board is read-only.
    const READ_ONLY = buildAbility([{ action: 'read', subject: 'all' }]);
    vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
      selector({
        user: { id: 'tech-1', email: 'tech@test.com', first_name: 'Tess', last_name: 'Tech', role: 'TECHNICIAN' },
        isAuthenticated: true,
        isLoading: false,
        error: null,
      } as never),
    );
    const utils = renderWithProviders(
      <TooltipProvider>
        <SchedulePage />
      </TooltipProvider>,
      { ability: READ_ONLY, initialEntries: ['/schedule'] },
    );
    await waitFor(() => expect(utils.container.querySelector('.schedule-cal .animate-spin')).toBeNull());
    const sheet = await openSheet(true);
    fireEvent.click((await within(sheet).findByText('J00043')).closest('div[class*="rounded-lg"]') as HTMLElement);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Unscheduled jobs' })).toBeNull());
    // The editor opens (view-only): it has no Schedule button, so nothing here can write.
    const editor = await screen.findByRole('dialog');
    expect(within(editor).queryByRole('button', { name: 'Schedule' })).toBeNull();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
