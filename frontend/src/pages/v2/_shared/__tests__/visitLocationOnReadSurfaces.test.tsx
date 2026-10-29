/**
 * WHERE THE VISIT IS, ON THE SURFACES THAT READ A VISIT - slice 6.
 *
 * Spec:  md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D2, D4)
 * Slice: md_files/issues/scheduling/06-show-the-location-where-the-visit-is-read.md
 *
 * Slices 1-5 let the office SET where a visit happens and let an automation TELL the customer.
 * Everyone INSIDE the organisation still read the customer's address off the visit, which is now
 * sometimes wrong - and a technician sent to the wrong side of town is a worse outcome than a
 * customer told the wrong place, because nobody catches it until they arrive.
 *
 * ── THE RULE EVERY CASE BELOW IS AN INSTANCE OF ───────────────────────────────────────────────
 *
 * SHOW THE DIFFERENCE, NOT THE ADDRESS, WHEN THERE IS NO DIFFERENCE. The great majority of visits
 * are at the service address; printing it on every card would be noise on the common case to serve
 * the rare one. So a visit at the service address renders EXACTLY as it did before - no new line,
 * no empty label - and only a visit that is somewhere else says so.
 *
 * Three surfaces, one spec file, because the whole point is that they behave identically: a
 * cross-module test is precisely what `moduleIsolation` exempts, and three per-module copies of
 * these assertions is how two of them would quietly stop agreeing.
 *
 * WHAT IS *NOT* ASSERTED HERE, and where it is instead: that the string on a card is the string in
 * the customer's email. That is an agreement between two server-side resolutions and it is asserted
 * as an agreement, over one visit row, in backend/src/__tests__/visit-location-read.test.ts. These
 * surfaces render what the API hands them and must not re-derive it - which is itself asserted
 * below, because a client that reformatted the label would be the second resolution the slice
 * exists to prevent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import { asWallClock } from '@/lib/schedule-tz';
import type { JobVisitRow } from '@/lib/visits';
import type { SchedulableEvent } from '@/components/schedule/scheduleModel';

import { WalkthroughTabContent } from '@/pages/v2/leads/components/walkthroughTab';
import { VisitsCard } from '@/pages/v2/jobs/components/visitsCard';
import { EventEditor } from '@/pages/v2/schedule/components/eventEditor';

/** The two strings the API resolves; every surface renders one of them VERBATIM or nothing. */
const AT_SHOWROOM = 'Showroom, 12 Harbor St, Asheville, NC';
const AT_ONE_OFF = '400 Supplier Rd, Charlotte, NC';

const SALES = { id: 'u-sales', first_name: 'Sam', last_name: 'Sales' };

vi.mock('react-router-dom', async (orig) => ({
  ...((await orig()) as object),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/api/users', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/users')>()),
  useAssignableUsers: () => ({ data: [] }),
}));

vi.mock('@/lib/api/locations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/locations')>()),
  useLocations: () => ({ data: [] }),
}));

vi.mock('@/lib/schedule-tz', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/schedule-tz')>()),
  useScheduleTimezone: () => 'America/New_York',
}));

vi.mock('@/lib/axios', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: [] }),
  },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const ABILITY = buildAbility([
  { action: 'read', subject: 'all' },
  { action: 'update', subject: 'Job' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
]);

beforeEach(() => {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({
      user: { ...SALES, email: 'sam@test.com', role: 'SALES' },
      isAuthenticated: true, isLoading: false, error: null,
    } as never),
  );
});

// ── the three surfaces, each reduced to "render one visit" ──────────────────

/** A booked walkthrough on the lead's tab, with `label` as its resolved location. */
function renderLeadTab(label: string | null, historyLabel: string | null = null) {
  return renderWithProviders(
    <WalkthroughTabContent
      lead={{
        walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z',
        walkthrough_completed_at: null,
        walkthrough_cancelled_at: null,
        walkthrough_duration_minutes: 60,
        walkthrough_notes: '',
        walkthrough_performers: [{ user: SALES }],
        walkthrough_location: null,
        walkthrough_location_label: label,
        walkthrough_count: 2,
        walkthrough_history: [
          {
            id: 'w-current', visit_seq: 1, status: 'SCHEDULED',
            scheduled_at: '2026-09-10T15:00:00.000Z',
            completed_at: null, cancelled_at: null, cancelled_reason: null,
            created_at: '2026-08-20T10:00:00.000Z',
            location_label: label,
          },
          {
            id: 'w-earlier', visit_seq: 2, status: 'COMPLETED',
            scheduled_at: '2026-08-01T15:00:00.000Z',
            completed_at: '2026-08-01T16:00:00.000Z', cancelled_at: null, cancelled_reason: null,
            created_at: '2026-07-20T10:00:00.000Z',
            location_label: historyLabel,
          },
        ],
      }}
      leadId="lead-1"
      canPerformWalkthrough={false}
      canScheduleWalkthrough
    />,
    { ability: ABILITY },
  );
}

function jobVisit(label: string | null): JobVisitRow {
  return {
    id: 'v-1', visit_seq: 1, status: 'SCHEDULED',
    scheduled_at: '2026-09-05T13:00:00.000Z',
    scheduled_end: '2026-09-05T15:30:00.000Z',
    is_all_day: false,
    created_at: '2026-08-20T10:00:00.000Z',
    assignees: [],
    location_label: label,
  } as unknown as JobVisitRow;
}

function renderJobVisitsCard(label: string | null) {
  return renderWithProviders(
    <VisitsCard jobId="job-1" visits={[jobVisit(label)]} canSchedule={false} />,
    { ability: ABILITY },
  );
}

function scheduleEvent(label: string | null): SchedulableEvent {
  return {
    boardId: 'jv-v-1',
    parentId: 'job-1',
    visitId: 'v-1',
    visitSeq: 1,
    type: 'job',
    number: 'J00043',
    title: 'Rooftop Unit Swap',
    customer: 'Acme Corp',
    crew: [],
    ownerId: null,
    locationLabel: label,
    start: asWallClock(new Date(2026, 5, 10, 9, 0)),
    end: asWallClock(new Date(2026, 5, 10, 11, 0)),
    raw: { status: 'SCHEDULED', customer: { phone: null }, assignees: [] },
  };
}

function renderScheduleDetail(label: string | null) {
  const props: ComponentProps<typeof EventEditor> = {
    open: true,
    event: scheduleEvent(label),
    members: [],
    canAssignOthers: true,
    canUnschedule: true,
    onSaveCrew: vi.fn(),
    onSaveTime: vi.fn(),
    onUnschedule: vi.fn(),
    onComplete: vi.fn(),
    onClose: vi.fn(),
  };
  return renderWithProviders(<EventEditor {...props} />, { ability: ABILITY });
}

/** The renderers, by the name the acceptance list gives each surface. */
const SURFACES = [
  ["the lead's visit card", renderLeadTab],
  ["the job's visits card", renderJobVisitsCard],
  ['the schedule detail', renderScheduleDetail],
] as const;

/** Every location line on screen, as plain text. */
function locationLines(): string[] {
  return screen.queryAllByTestId('visit-location').map((n) => n.textContent ?? '');
}

// ── a company location, and a one-off, on all three ─────────────────────────

describe('a visit somewhere other than the service address says where it is', () => {
  for (const [surface, render] of SURFACES) {
    it(`shows a company location on ${surface}`, () => {
      render(AT_SHOWROOM);

      expect(locationLines()).toContain(AT_SHOWROOM);
    });

    /**
     * D4: being ad hoc is a statement about whether the address is SAVED TO THE LOCATIONS LIST,
     * not about what an address is. A one-off that rendered differently from a company location
     * would be the only address in the product that behaves that way.
     */
    it(`shows a one-off address on ${surface}, exactly as it shows a company location`, () => {
      const oneOff = render(AT_ONE_OFF);
      const oneOffNode = screen.getAllByTestId('visit-location')[0]!;
      const oneOffMarkup = oneOffNode.parentElement!.className;
      expect(oneOffNode.textContent).toBe(AT_ONE_OFF);
      oneOff.unmount();

      render(AT_SHOWROOM);
      const companyNode = screen.getAllByTestId('visit-location')[0]!;

      // Same element, same classes, same place in the card - the two are indistinguishable
      // except for the string, which is the whole of D4's consistency requirement on a READ
      // surface. Compared structurally rather than eyeballed, so restyling one drags the other.
      expect(companyNode.tagName).toBe(oneOffNode.tagName);
      expect(companyNode.className).toBe(oneOffNode.className);
      expect(companyNode.parentElement!.className).toBe(oneOffMarkup);
    });
  }
});

// ── the common case: nothing at all ─────────────────────────────────────────

describe('a visit at the service address renders as it does today', () => {
  for (const [surface, render] of SURFACES) {
    it(`adds no line and no empty label on ${surface}`, () => {
      render(null);

      // Not "is empty" - ABSENT. An empty label is a marked line with nothing in it, which is the
      // visual twin of the "Please meet us at  ." D7 forbids in an inbox.
      expect(screen.queryAllByTestId('visit-location')).toHaveLength(0);
    });

    /**
     * A payload from before this shipped carries NO key at all, which is not the same claim as
     * `null` - and both must read the same way here, because a surface with nothing to show has
     * nothing better to offer than showing nothing.
     */
    it(`adds no line for a payload that predates the field on ${surface}`, () => {
      render(undefined as unknown as null);

      expect(screen.queryAllByTestId('visit-location')).toHaveLength(0);
    });
  }
});

// ── the surface renders what it is given, and nothing else ──────────────────

describe('the surfaces render the resolved line verbatim', () => {
  /**
   * THE SECOND-RESOLUTION GUARD. The server resolves "name, then address, in this order, unless it
   * is blank" once, and `formatVisitLocation` - the merge field the customer's email renders - is
   * defined in terms of the same function. A client that reformatted, truncated, re-cased or
   * re-ordered the string would be a second resolution, free to drift from the email, and the
   * drift would be invisible until somebody drove to the wrong place.
   *
   * Asserted with a string the client could not possibly have composed itself.
   */
  for (const [surface, render] of SURFACES) {
    it(`prints the server's string unchanged on ${surface}`, () => {
      const opaque = 'Bay 2 Annexe, 400 Supplier Rd, Charlotte, NC';
      render(opaque);

      expect(locationLines()).toContain(opaque);
    });
  }
});

// ── the lead tab's OTHER trips ──────────────────────────────────────────────

describe("the lead's earlier trips say where they were, too", () => {
  it('marks a past visit held somewhere else', async () => {
    const user = userEvent.setup();
    renderLeadTab(null, AT_ONE_OFF);

    // The history list is collapsed until asked for - the tab's existing behaviour.
    await user.click(screen.getByRole('button', { name: /Visits Total/i }));

    expect(locationLines()).toContain(AT_ONE_OFF);
  });

  it('leaves a past visit at the service address unmarked', async () => {
    const user = userEvent.setup();
    renderLeadTab(null, null);

    await user.click(screen.getByRole('button', { name: /Visits Total/i }));

    expect(screen.queryAllByTestId('visit-location')).toHaveLength(0);
  });
});

// ── mobile ──────────────────────────────────────────────────────────────────
//
// jsdom has no layout engine, so "intact at 375px" cannot be measured - it is asserted as the two
// things that would actually break it, both of which a real browser would then honour:
//
//   (1) the line is still THERE. A `hidden sm:flex` - the obvious way to make a long address stop
//       crowding a narrow card - would hide from a technician on a phone the one fact this slice
//       exists to give them, and every case above would stay green because they run at the jsdom
//       default width.
//   (2) a long address TRUNCATES instead of widening its card. Without it the flex row grows to
//       its content and the whole card scrolls sideways on a phone.

describe('mobile - the line survives a narrow viewport and a long address', () => {
  const REAL_WIDTH = window.innerWidth;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      // Every `max-width` query matches and every `min-width` one does not: a 375px phone.
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: REAL_WIDTH });
  });

  const LONG = 'North Yard Receiving & Fabrication Annexe, 1400 Industrial Parkway West, Charlotte, NC';

  for (const [surface, render] of SURFACES) {
    it(`still shows the line at 375px on ${surface}`, () => {
      render(LONG);

      expect(locationLines()).toContain(LONG);
      // ...and is not hidden by a breakpoint either. jsdom applies no CSS, so a `hidden sm:flex`
      // - the obvious way to stop a long address crowding a narrow card - would leave the
      // assertion above green while a technician on a phone saw nothing. The class is what has
      // to be absent, so the class is what is asserted.
      const row = screen.getAllByTestId('visit-location')[0]!.parentElement!;
      expect(row.className.split(/\s+/)).not.toContain('hidden');
      expect(row.className).not.toMatch(/(^|\s)max-\w+:hidden/);
    });

    it(`truncates rather than widening the card on ${surface}`, () => {
      render(LONG);
      const node = screen.getAllByTestId('visit-location')[0]!;

      // `truncate` on the text, `min-w-0` on the flex row that holds it - a flex child will not
      // shrink below its content without the second, so the first alone does nothing.
      expect(node.className).toContain('truncate');
      expect(node.parentElement!.className).toContain('min-w-0');
    });
  }
});

// ── the marking ─────────────────────────────────────────────────────────────

describe('the line is marked, not merely present', () => {
  /**
   * "Marked clearly enough that a dispatcher scanning a day notices without reading."
   *
   * An address that looked like every other muted line under a visit would be read only by
   * somebody already looking for it. The mark is an icon no sibling line on these cards carries,
   * and - because an icon is nothing to a screen reader - a text label that says what the line is.
   */
  it('carries a pin and an accessible name that is not just the address', () => {
    renderJobVisitsCard(AT_SHOWROOM);
    const row = screen.getByTestId('visit-location').parentElement!;

    expect(within(row).getByText(/^Location:/)).toBeInTheDocument();
    expect(row.querySelector('svg')).not.toBeNull();
  });

  it('does not leave that label behind when there is nothing to mark', () => {
    renderJobVisitsCard(null);

    expect(screen.queryByText(/^Location:/)).toBeNull();
  });
});
