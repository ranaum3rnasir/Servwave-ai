/**
 * Mobile slice 60 - tap alternatives for the two scheduler gestures a finger cannot make.
 *
 *   1. A Plan Mode draft's Confirm / Remove menu opened on RIGHT-CLICK only. A tap on the draft
 *      now opens that same menu, on the standard calendar and on both member boards.
 *   2. Widening one day of the week view needed a DOUBLE-CLICK on the column. Each day header now
 *      carries a button that does the same by one tap (shown on touch screens; reachable by
 *      keyboard everywhere).
 *
 * jsdom has no stylesheet or pointer type, so sizes and the touch-only paint are asserted in the
 * real-browser mobile gate (e2e/mobile/scheduler-tap-alternatives.spec.ts). What jsdom CAN pin is
 * the behaviour: what a click on a draft opens, what that menu does, and what the header button
 * toggles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// usePlanMode reads its storage key off a per-tab id at MODULE LOAD, so it has to exist before
// SchedulePage (and through it the hook) is imported.
vi.hoisted(() => sessionStorage.setItem('plan-mode-tab-id', 'm60-tap-test'));

import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, format, startOfWeek } from 'date-fns';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from '@/__tests__/helpers';
import { TooltipProvider } from '@/ui-kit/components/ui/tooltip';
import type { GhostEvent } from '@/hooks/usePlanMode';
import SchedulePage from '@/pages/v2/schedule/SchedulePage';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
const mockApi = vi.mocked(api);
const STORAGE_KEY = 'plan-mode-m60-tap-test';
const WEEK_START = startOfWeek(new Date(), { weekStartsOn: 0 });

function dayAt(offset: number, hour = 14): string {
  const d = addDays(WEEK_START, offset);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0)).toISOString();
}

const DRAFT: GhostEvent = {
  id: 'g-tap-1',
  sourceId: 'job-1',
  sourceType: 'job',
  isFromSidebar: false,
  isMovedConfirmed: false,
  start: dayAt(3),
  end: dayAt(3, 16),
  crew: [],
  title: 'Gate operator swap',
  customerName: 'Pat Sample',
  address: '',
  raw: { job_number: 'J00177', customer: { first_name: 'Pat', last_name: 'Sample' } },
};

function seedDraft() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ isActive: true, ghosts: [DRAFT], updatedAt: Date.now() }));
}

function mockBoard() {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/jobs') return Promise.resolve({ data: { jobs: [] } });
    if (url === '/api/departments') return Promise.resolve({ data: { departments: [] } });
    if (url === '/api/leads') return Promise.resolve({ data: { leads: [] } });
    if (url === '/api/users' || url === '/api/users/assignable') return Promise.resolve({ data: { users: [] } });
    if (url === '/api/service-plans/scheduler-bucket') return Promise.resolve({ data: { plans: [] } });
    return Promise.resolve({ data: {} });
  });
}

function renderPage() {
  return renderWithProviders(
    <TooltipProvider>
      <SchedulePage />
    </TooltipProvider>,
    { ability: ADMIN },
  );
}

/** The draft's card on the standard calendar: the event wrapper that holds the "draft" badge. */
async function findDraftCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector('[data-draft-badge]')).not.toBeNull());
  return document.querySelector('[data-draft-badge]')!.closest('.rbc-event') as HTMLElement;
}

const overlayMenu = () => document.querySelector<HTMLElement>('[data-schedule-overlay]');

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // A view picked on the page is kept for the session; one test opens Day view, so start clean.
  // (The plan-mode tab id is read once at import, so clearing it here changes nothing.)
  sessionStorage.clear();
  mockBoard();
  mockApi.patch.mockResolvedValue({ data: {} });
  mockApi.post.mockResolvedValue({ data: {} });
});

describe('a Plan Mode draft offers Confirm and Remove by tap', () => {
  it('a tap on the draft opens a menu with Confirm and Remove', async () => {
    seedDraft();
    renderPage();
    const card = await findDraftCard();
    expect(overlayMenu(), 'no menu before the tap').toBeNull();

    fireEvent.click(card, { clientX: 300, clientY: 300 });

    const menu = await waitFor(() => {
      const m = overlayMenu();
      expect(m, 'the draft menu opens on a plain click').not.toBeNull();
      return m!;
    });
    expect(within(menu).getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
    expect(within(menu).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('Remove from that menu discards the draft', async () => {
    seedDraft();
    renderPage();
    fireEvent.click(await findDraftCard(), { clientX: 300, clientY: 300 });
    const menu = await waitFor(() => {
      expect(overlayMenu()).not.toBeNull();
      return overlayMenu()!;
    });

    fireEvent.click(within(menu).getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(document.querySelector('[data-draft-badge]')).toBeNull());
    expect(overlayMenu(), 'the menu closes').toBeNull();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('Confirm from that menu opens the schedule confirmation for that draft', async () => {
    seedDraft();
    renderPage();
    fireEvent.click(await findDraftCard(), { clientX: 300, clientY: 300 });
    const menu = await waitFor(() => {
      expect(overlayMenu()).not.toBeNull();
      return overlayMenu()!;
    });

    fireEvent.click(within(menu).getByRole('button', { name: 'Confirm' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Schedule Job\?/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Confirm & Schedule/ })).toBeInTheDocument();
    // Opening the confirmation writes nothing: the draft is only committed by the dialog's button.
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('a day of the week view can be widened by tap', () => {
  const dayName = (offset: number) => format(addDays(WEEK_START, offset), 'EEEE, MMMM d');

  it('every day header carries a named widen button, off to start with', async () => {
    renderPage();
    for (let i = 0; i < 7; i += 1) {
      const btn = await screen.findByRole('button', { name: `Widen ${dayName(i)}` });
      expect(btn).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('no header button sits inside another button (the library would wrap the header in one)', async () => {
    renderPage();
    await screen.findByRole('button', { name: `Widen ${dayName(0)}` });
    expect(document.querySelectorAll('.schedule-cal .rbc-header button button')).toHaveLength(0);
  });

  it('the date still opens its day: tapping it moves to the Day view', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: `Open ${dayName(2)}` }));
    // The header defers its click 250 ms (so a double-click can cancel it), then drills into Day.
    await waitFor(() => expect(screen.queryAllByRole('button', { name: /^Widen / })).toHaveLength(0), { timeout: 2000 });
  });

  it('tapping it widens that column, and tapping it again narrows it', async () => {
    renderPage();
    const cal = () => document.querySelector('.schedule-cal') as HTMLElement;
    expect(cal().getAttribute('data-focus-day')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: `Widen ${dayName(3)}` }));
    expect(cal().getAttribute('data-focus-day')).toBe('3');
    expect(screen.getByRole('button', { name: `Widen ${dayName(3)}` })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: `Widen ${dayName(3)}` }));
    expect(cal().getAttribute('data-focus-day')).toBeNull();
  });

  it('the button the finger or keyboard used is still the same button afterwards (focus is not lost)', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: `Widen ${dayName(4)}` });
    btn.focus();
    fireEvent.click(btn);
    // A header that is rebuilt on every toggle drops focus to the page: a keyboard user could then
    // not narrow the day again without tabbing all the way back.
    expect(btn.isConnected, 'the same node is still on the page').toBe(true);
    expect(document.activeElement).toBe(btn);
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('widening a second day moves the widening to that day', async () => {
    renderPage();
    const cal = () => document.querySelector('.schedule-cal') as HTMLElement;
    fireEvent.click(await screen.findByRole('button', { name: `Widen ${dayName(1)}` }));
    fireEvent.click(screen.getByRole('button', { name: `Widen ${dayName(5)}` }));
    expect(cal().getAttribute('data-focus-day')).toBe('5');
    expect(screen.getByRole('button', { name: `Widen ${dayName(1)}` })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the tap widens only: it does not also drill into that day', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: `Widen ${dayName(2)}` }));
    // The header's own click drills into Day view after a short delay; wait past it.
    await new Promise((r) => setTimeout(r, 400));
    // Still the week view (Day view has one header, so the seven buttons would be gone) and the
    // column is still widened (a view change resets it).
    expect(screen.getAllByRole('button', { name: /^Widen / })).toHaveLength(7);
    expect((document.querySelector('.schedule-cal') as HTMLElement).getAttribute('data-focus-day')).toBe('2');
  });
});
