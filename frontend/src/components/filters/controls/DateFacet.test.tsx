import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { DateFacet } from './DateFacet';
import type { FacetConfig, FilterValue } from '@/lib/filters/types';

const facet: FacetConfig = {
  key: 'created',
  label: 'Created',
  icon: 'M0 0',
  kind: 'dateRange',
  param: 'created',
};

/** The org-fact twin of `facet` above - same shape, different key/label/param. */
const scheduledFacet: FacetConfig = {
  ...facet,
  key: 'scheduled',
  label: 'Scheduled',
  param: 'scheduled',
};

// useScheduleTimezone reads org.timezone through this module - same mock shape
// as job-detail-schedule-timezone.test.tsx. Asia/Manila is the house's usual
// org-zone test fixture: it differs from every plausible CI runner zone, so a
// bug that silently used the runner's zone instead of this mock would still
// be caught even without the explicit `process.env.TZ` override further down.
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', timezone: 'Asia/Manila' },
      isLoading: false,
      isError: false,
    }),
  };
});

describe('DateFacet', () => {
  it('defaults to the "Any time" preset when value is undefined', () => {
    renderWithProviders(<DateFacet facet={facet} value={undefined} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Any time');
  });

  it('reflects an existing dateRange value into DateRangeField (matches the "Today" preset)', () => {
    const value: FilterValue = { kind: 'dateRange', from: '', to: '' };
    renderWithProviders(<DateFacet facet={facet} value={value} onChange={() => {}} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Any time');
  });

  it('wraps DateRangeField onChange into a proper dateRange FilterValue', async () => {
    const onChange = vi.fn();
    renderWithProviders(<DateFacet facet={facet} value={undefined} onChange={onChange} />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'Today' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0] as FilterValue;
    expect(arg.kind).toBe('dateRange');
    if (arg.kind === 'dateRange') {
      expect(arg.from).toBe(arg.to); // "Today" preset: from === to
      expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('passes facet.label through as the aria label', () => {
    renderWithProviders(<DateFacet facet={facet} value={undefined} onChange={() => {}} />);
    expect(screen.getByLabelText('Created range')).toBeInTheDocument();
  });
});

/**
 * #1634 — org-zone threading. `DateFacet` renders every dateRange facet a
 * registry declares; only "scheduled" (a real scheduling fact) is supposed to
 * get the org zone, and every other facet key - "created" here - must keep the
 * pre-existing browser-clock behaviour byte-for-byte (no silent flip in either
 * direction).
 *
 * Per the house rule on discriminating instants: every assertion below uses an
 * instant that renders on DIFFERENT calendar days in the mocked org zone
 * (Asia/Manila) and the simulated browser zone (America/New_York), plus one
 * control instant that renders the SAME day in both - proving the probe can
 * actually tell a correct implementation from a broken one, not just that it
 * always reports "different".
 */
describe('DateFacet — #1634 org zone (scheduled) vs browser zone (created, unmigrated)', () => {
  const BROWSER_TZ = 'America/New_York'; // simulates the viewer's own machine
  // 2026-08-24T22:00:00Z is 6:00 PM Aug 24 in New York and 6:00 AM Aug 25 in
  // Manila - it splits the calendar day between the two zones under test.
  const DISCRIMINATING_INSTANT = '2026-08-24T22:00:00.000Z';
  // 2026-08-24T13:00:00Z is 9:00 AM in New York and 9:00 PM in Manila - same
  // calendar day in both. The control: if this ALSO produced different days,
  // the probe below would be meaningless.
  const CONTROL_INSTANT = '2026-08-24T13:00:00.000Z';

  let originalTz: string | undefined;
  beforeEach(() => {
    originalTz = process.env.TZ;
    process.env.TZ = BROWSER_TZ;
  });
  afterEach(() => {
    process.env.TZ = originalTz;
    vi.useRealTimers();
  });

  /** Renders `facet`, opens the Select, picks "Today", and returns the onChange arg's `from`. */
  async function pickTodayFrom(targetFacet: FacetConfig): Promise<string> {
    const onChange = vi.fn();
    renderWithProviders(<DateFacet facet={targetFacet} value={undefined} onChange={onChange} />);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0]![0] as FilterValue;
    expect(arg.kind).toBe('dateRange');
    return arg.kind === 'dateRange' ? arg.from : '';
  }

  it('REQUIRED: the "scheduled" facet\'s Today preset selects the ORG\'s today when the browser clock and the org clock disagree', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DISCRIMINATING_INSTANT));

    const from = await pickTodayFrom(scheduledFacet);

    expect(from).toBe('2026-08-25'); // Manila's (the org's) today
    expect(from).not.toBe('2026-08-24'); // NOT New York's (the browser's) today
  });

  it('control: at an instant that does not split the day, the org and browser today agree', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(CONTROL_INSTANT));

    const from = await pickTodayFrom(scheduledFacet);

    expect(from).toBe('2026-08-24'); // same calendar day in both zones
  });

  it('NO SILENT FLIP: the "created" facet stays on the browser clock even though the org clock disagrees', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(DISCRIMINATING_INSTANT));

    const from = await pickTodayFrom(facet); // facet.key === 'created', never migrated

    expect(from).toBe('2026-08-24'); // New York's (the browser's) today
    expect(from).not.toBe('2026-08-25'); // NOT Manila's (the org's) today
  });
});
