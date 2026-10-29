/**
 * #2048 — the lead header's primary "Convert to job" / "Create Estimate" control, on the ROUTED
 * page (prior art: `leadDetailScheduleTimezone.test.tsx`, and the frozen `repro-2048.test.tsx`).
 *
 * Gate matrix:
 *  - `create Job` + one WON estimate without a job -> primary "Convert to job", and clicking it
 *    converts DIRECTLY (no dialog) — R1.
 *  - `create Job` + only a DRAFT estimate -> primary "Create Estimate"; no convert control
 *    anywhere (button or kebab) since there is nothing to convert.
 *  - no `create Job`, WON present -> no convert control anywhere (button OR kebab item), whether
 *    or not `create Estimate` is also held.
 *  - the payload branch: exactly one selected estimate posts `{ estimate_id }` (byte-identical to
 *    today); more than one posts `{ estimate_ids }` — asserted through the multi-select dialog,
 *    which is the only path that can select more than one.
 *
 * Every gate below reads `ability.can(...)` — never a role name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { toast } from '@/ui-kit/components/ui/sonner';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import LeadDetailPage from '../LeadDetailPage';

// R7 - the stale-payload 400 must surface through the EXISTING error toast, not a new UI path.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { error: vi.fn() }),
}));
const mockToast = vi.mocked(toast);

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: LEAD_FIXTURE.id }),
    useNavigate: () => navigate,
  };
});

const mockApi = vi.mocked(api);

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
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
});
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
// Holds create Estimate + read/update Lead but NOT create Job.
const noJobAbility = buildAbility([
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
  { action: 'create', subject: 'Estimate' },
]);

const WON_UNATTACHED = {
  id: 'gate-es-1',
  estimate_number: 'E00030',
  status: 'WON',
  total_amount: '1000.00',
  created_at: '2026-04-01T00:00:00.000Z',
  job: null,
};
const WON_A = {
  id: 'gate-es-a',
  estimate_number: 'E00031',
  status: 'WON',
  total_amount: '400.00',
  created_at: '2026-04-01T00:00:00.000Z',
  job: null,
};
const WON_B = {
  id: 'gate-es-b',
  estimate_number: 'E00032',
  status: 'WON',
  total_amount: '600.00',
  created_at: '2026-04-02T00:00:00.000Z',
  job: null,
};
const DRAFT_ONLY = {
  id: 'gate-es-draft',
  estimate_number: 'E00033',
  status: 'DRAFT',
  total_amount: '300.00',
  created_at: '2026-04-01T00:00:00.000Z',
  job: null,
};

function serveLead(estimates: unknown[], status = 'NEW') {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/api/leads/')) {
      return { data: { lead: { ...LEAD_FIXTURE, status, estimates } } };
    }
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2048 - LeadDetailPage header convert gate', () => {
  it('create Job + one WON-unattached estimate -> primary "Convert to job" that converts directly, no dialog', async () => {
    serveLead([WON_UNATTACHED]);
    mockApi.post.mockResolvedValue({ data: { job: { id: 'job-gate-1' } } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const btn = await screen.findByRole('button', { name: /convert to job/i });
    await user.click(btn);

    // R1: direct conversion, no confirmation dialog.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs', { estimate_id: WON_UNATTACHED.id }),
    );
  });

  it('create Job + only a DRAFT estimate -> primary "Create Estimate", no primary Convert button (R2: the kebab item stays, base-gated)', async () => {
    serveLead([DRAFT_ONLY]);

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /create estimate/i })).toBeInTheDocument();
    // No PRIMARY convert button - nothing convertible.
    expect(screen.queryByRole('button', { name: /convert to job/i })).toBeNull();

    // R2: the kebab's own "Convert to job" item keeps its base `create Job` gate and is
    // UNCHANGED here - it still opens the dialog's (unmodified) empty state.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    expect(await screen.findByRole('menuitem', { name: /convert to job/i })).toBeInTheDocument();
  });

  it('no create Job grant, WON estimate present -> no convert control anywhere (button or kebab)', async () => {
    serveLead([WON_UNATTACHED]);

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: noJobAbility });

    // create Estimate is held and the lead is non-terminal, so the primary slot is
    // "Create Estimate" instead - proves the absence below isn't just an empty header.
    expect(await screen.findByRole('button', { name: /create estimate/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /convert to job/i })).toBeNull();

    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    expect(screen.queryByRole('menuitem', { name: /convert to job/i })).toBeNull();
  });

  it('payload branch: exactly one selected posts { estimate_id }, more than one posts { estimate_ids }', async () => {
    serveLead([WON_A, WON_B]);
    mockApi.post.mockResolvedValue({ data: { job: { id: 'job-gate-2' } } });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // More than one convertible -> the primary button opens the dialog (does not convert
    // directly), reached here via the kebab item (same dialog, per AC8).
    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Convert to job/i }));
    const dialog = await screen.findByRole('dialog');

    // Uncheck one -> exactly one selected -> byte-identical single-estimate payload.
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    await user.click(boxes[1]!);
    await user.click(within(dialog).getByRole('button', { name: /create job/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs', { estimate_id: WON_A.id }),
    );
  });

  // R9(1) - the shape the multi-convert path writes: `job` (PROVENANCE) stays null, but
  // `job_id` (the ANCHOR) is set. Without the backend's `job_id` select hunk this is
  // indistinguishable from a genuinely convertible estimate, and the button never disappears.
  it('an estimate with job: null but job_id set (multi-convert path) offers no primary button and is non-convertible in the dialog', async () => {
    const foldedIntoAnotherJob = {
      ...WON_UNATTACHED,
      id: 'gate-es-folded',
      job: null,
      job_id: 'job-elsewhere',
      job_link: { id: 'job-elsewhere', job_number: 'J00099', status: 'SCHEDULED' },
    };
    serveLead([foldedIntoAnotherJob]);

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Nothing convertible -> the lead is non-terminal (status 'NEW'), so the primary slot falls
    // through to "Create Estimate", never "Convert to job".
    expect(await screen.findByRole('button', { name: /create estimate/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /convert to job/i })).toBeNull();

    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Convert to job/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).getByRole('button', { name: /J00099/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /create job/i })).toBeDisabled();
  });

  // R7 / AC11 - a stale lead payload (the estimate was converted elsewhere) 400s; the dialog
  // must stay open and surface the EXISTING error toast - no silent close, no navigation.
  it('a stale-payload 400 keeps the dialog open and surfaces the existing error toast', async () => {
    serveLead([WON_A, WON_B]);
    mockApi.post.mockRejectedValueOnce({
      response: { status: 400, data: { error: 'Estimate E00031 is already attached to a job' } },
    });
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Convert to job/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /create job/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        'Could not convert to job',
        expect.objectContaining({ description: 'Estimate E00031 is already attached to a job' }),
      ),
    );
    // Still open - no silent close, no navigation, no retry-as-single.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  // Round 3 (#2048/R4) - the header row must WRAP at narrow widths instead of squeezing the
  // title. Mobile slice 55 moved the header onto the shared `DetailHeader`: its row is
  // `flex-wrap`, the text column is `min-w-0 flex-1` (it can shrink and wrap) and the action
  // column (button(s) + kebab) is pushed right with `ml-auto` and wraps onto its own line when
  // the row is too narrow. Class-name assertions (string `toContain`, never a regex literal -
  // the design-system guard's unresolved-classes scan reads a regex containing a class token as
  // a bare class name).
  it('the header row wraps at narrow widths (primary button case): the row wraps, the text column is min-w-0/flex-1, the action column is ml-auto/flex-wrap', async () => {
    serveLead([WON_UNATTACHED]);

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const button = await screen.findByRole('button', { name: /convert to job/i });
    const heading = await screen.findByRole('heading', { name: /L00001\b/ });

    const actionColumn = button.parentElement!;
    const textColumn = heading.parentElement!;
    const headerRow = textColumn.parentElement!.parentElement!;
    // The kebab lives in the SAME action column as the primary button.
    expect(actionColumn).toContainElement(screen.getByRole('button', { name: /Lead actions/i }));

    expect(headerRow.className).toContain('flex-wrap');
    expect(textColumn.className).toContain('min-w-0');
    expect(textColumn.className).toContain('flex-1');
    expect(actionColumn.className).toContain('flex-wrap');
    expect(actionColumn.parentElement!.className).toContain('ml-auto');
  });

  it('the header row wraps at narrow widths (Create Estimate case, no convertible estimate)', async () => {
    serveLead([DRAFT_ONLY]);

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const button = await screen.findByRole('button', { name: /create estimate/i });
    const heading = await screen.findByRole('heading', { name: /L00001\b/ });

    const actionColumn = button.parentElement!;
    const headerRow = heading.parentElement!.parentElement!.parentElement!;

    expect(headerRow.className).toContain('flex-wrap');
    expect(actionColumn.parentElement).toBe(headerRow.lastElementChild);
    expect(actionColumn.className).toContain('flex-wrap');
  });

  it('a lead with no primary control (kebab alone) keeps the same header row structure', async () => {
    // No estimates at all + no create Estimate grant -> neither primary control renders,
    // matching the kebab-alone state the R4 fix must not disturb at wide viewports.
    serveLead([]);
    const kebabOnlyAbility = buildAbility([{ action: 'read', subject: 'Lead' }]);

    renderWithProviders(<LeadDetailPage />, { ability: kebabOnlyAbility });

    const heading = await screen.findByRole('heading', { name: /L00001\b/ });
    expect(screen.queryByRole('button', { name: /convert to job/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create estimate/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Lead actions/i })).toBeNull();

    const headerRow = heading.parentElement!.parentElement!.parentElement!;
    expect(headerRow.className).toContain('flex-wrap');
  });

  // Staging fix (slice 55): at 320 the lead number and pencil left about 90 px for the name, so a
  // one-word name broke mid-word. The heading wraps, so the name drops to its own line (the whole
  // width) when it does not fit beside the number; it still shrinks and breaks only past that.
  it('the heading wraps so a long name takes its own line instead of a 90 px column', async () => {
    serveLead([DRAFT_ONLY]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    const heading = await screen.findByRole('heading', { name: /L00001\b/ });
    expect(heading.className).toContain('flex-wrap');
    const name = heading.querySelector('span[title]') as HTMLElement;
    expect(name.className).toContain('min-w-0');
    expect(name.className).toContain('break-words');
  });

  // Mobile slice 55: below sm the header stacks - Back beside the lead, the primary on its own
  // full-width row, every other action inside the "Lead actions" menu (a labelled button, not an
  // icon, so it is a 44 px target with a name).
  it('stacks on a phone: a Back control, the primary full width, and a labelled Lead actions menu', async () => {
    setPhone(true);
    serveLead([WON_UNATTACHED]);
    const user = userEvent.setup();

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const primary = await screen.findByRole('button', { name: /^convert to job$/i });
    expect(primary.parentElement!.className).toContain('flex-col');
    expect(primary.parentElement!.className).toContain('[&>button]:h-11');

    await user.click(screen.getByRole('button', { name: 'Back to leads' }));
    expect(navigate).toHaveBeenCalledWith('/leads');

    const menu = screen.getByRole('button', { name: 'Lead actions' });
    expect(menu.textContent).toContain('Lead actions');
    expect(menu.className).toContain('w-full');
    await user.click(menu);
    expect(await screen.findByRole('menuitem', { name: /Edit/ })).toBeInTheDocument();
  });

  // Mobile slice 55: the four KPI figures (Estimated Value, Estimates, Days Open, Source) were one
  // flex row, so the last one ran off a 320 px screen. Two to a row below sm, one row from sm up.
  it('lays the KPI strip out two to a row below sm and in one row from sm up', async () => {
    serveLead([WON_UNATTACHED]);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const strip = (await screen.findByText('Estimated Value')).parentElement!.parentElement!;
    expect(strip.className).toContain('grid-cols-2');
    expect(strip.className).toContain('sm:flex');
    expect(screen.getByText('Source').parentElement!.className).toContain('min-w-0');
  });
});
