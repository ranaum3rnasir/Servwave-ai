import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { buildAbility } from '@/lib/ability';

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: '2026-05-10T09:00:00.000Z',
  scheduled_end: null,
  started_at: '2026-05-10T09:00:00.000Z',
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: null,
  estimate: null,
  invoices: [] as Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: number | string;
    amount_due: number | string;
    created_at: string;
  }>,
  tags: [] as Array<{ id: string; name: string; color: string }>,
  source_plan_id: null,
  source_plan: null,
};

const FINANCIALS = {
  final_invoice: null,
  invoices: [],
  payments: [],
};

function mockJobAndFinancials(jobOverrides: Partial<typeof BASE_JOB> = {}) {
  const job = { ...BASE_JOB, ...jobOverrides };
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/financials')) {
      return { data: FINANCIALS };
    }
    if (url.includes('/api/jobs/')) {
      return { data: { job } };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JobDetailPage - command-center tab scaffold', () => {
  it('renders the command-center tabs in order', async () => {
    // Task 10 (Spec A): Logistics/Estimates/Payments are now ALSO ability-gated (read
    // Inventory/Estimate/Invoice respectively), same as the pre-existing Communication gate.
    const ability = buildAbility([
      { action: 'read', subject: 'Communication' },
      { action: 'read', subject: 'Inventory' },
      { action: 'read', subject: 'Estimate' },
      { action: 'read', subject: 'Invoice' },
    ]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });

    // Wait for job to load
    await screen.findByRole('heading', { name: /J00001/ });

    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    expect(tabs).toEqual([
      'Overview',
      // Multi-visit S2: a job holds its own visits now.
      'Visits',
      'Items',
      'Logistics',
      'Estimates',
      'Attachments',
      'Communication',
      'Tasks',
      'Notes',
      'Payments',
    ]);
  });

  it('omits Communication tab when ability is not granted', async () => {
    // Isolate the Communication gate specifically: grant the other three tab gates (Task 10)
    // so this test still proves the OTHER 8 tabs stay present when only Communication is denied.
    const ability = buildAbility([
      { action: 'read', subject: 'Inventory' },
      { action: 'read', subject: 'Estimate' },
      { action: 'read', subject: 'Invoice' },
    ]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });

    await screen.findByRole('heading', { name: /J00001/ });

    const tabs = (await screen.findAllByRole('tab')).map((t) => t.textContent?.trim());
    expect(tabs).not.toContain('Communication');
    // The other tabs are present
    expect(tabs).toEqual([
      'Overview',
      // Multi-visit S2: a job holds its own visits now.
      'Visits',
      'Items',
      'Logistics',
      'Estimates',
      'Attachments',
      'Tasks',
      'Notes',
      'Payments',
    ]);
  });
});

describe('JobDetailPage — IconRail panels', () => {
  it('keeps only the Activity rail panel on the job page', async () => {
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />);

    await screen.findByRole('heading', { name: /J00001/ });

    // The Activity rail icon-button must be present (rail buttons use title= as their accessible name)
    expect(await screen.findByRole('button', { name: /^activity$/i })).toBeInTheDocument();
    // The Attachments rail icon-button (title="Attachments") must NOT be present
    // (Attachments is now a tab, not a rail panel — the tab uses text content, not title=)
    const attachmentsRailBtn = document.querySelector('button[title="Attachments"]');
    expect(attachmentsRailBtn).toBeNull();
  });
});

describe('JobDetailPage — Command Center header', () => {
  it('renders the command-center header with job number, status, and service type', async () => {
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />);

    // Job number heading
    expect(await screen.findByRole('heading', { name: /J00001/ })).toBeInTheDocument();
    // Status badge appears in the header (StatusBadge in the title row)
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    // Service type summary card
    expect(screen.getByText('HVAC Installation')).toBeInTheDocument();
  });

  // "Schedule" is now "Next Visit" (D14a): the tile describes the next upcoming
  // visit rather than a single schedule field, and job.scheduled_start IS that
  // visit by D14's write-through mirror. A rename with a meaning behind it, not
  // a restyle - pages/v2/jobs/__tests__/jobVisits.test.tsx pins the same label.
  it('renders the info-band labels: Next Visit, Service, and the money block (Technician + Status cards removed)', async () => {
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />);

    await screen.findByRole('heading', { name: /J00001/ });

    expect(screen.getByText('Next Visit')).toBeInTheDocument();
    expect(screen.getByText('Service')).toBeInTheDocument();
    // Money block: this mock has no estimate/invoice → "Balance / No contract yet".
    expect(screen.getByText('Balance')).toBeInTheDocument();
    // Technician summary card removed — technicians live in the Team card now.
    const techSummaryLabels = screen
      .queryAllByText('Technician')
      .filter((el) => el.classList.contains('uppercase'));
    expect(techSummaryLabels).toHaveLength(0);
    // Status summary card label must be gone (only StatusBadge badge text remains, not the uppercase card label)
    const summaryStatusLabels = screen
      .queryAllByText('Status')
      .filter((el) => el.classList.contains('uppercase'));
    expect(summaryStatusLabels).toHaveLength(0);
  });
});

describe('JobDetailPage — R2 header action-cluster changes', () => {
  // R2 consolidated every action into the Actions menu. Mark Complete came back OUT of it:
  // a technician in the field could not find the one control the whole visit ends with, and
  // reported the job as impossible to close. Duplicate and the rest stay in the menu.
  //
  // The routed page had buried it back inside the menu - the fix above was made on
  // `pages/JobDetailPage.tsx`, which App.tsx does not route, so it never reached a
  // user. Repointing this file at the routed page is what surfaced that, and the
  // header button has been restored there. This assertion is what holds it.
  it('omits Status card, View Statement, and Start Job; surfaces Mark Complete, Actions menu holds Duplicate', async () => {
    // Admin role so canManage = true → canDuplicate, canComplete (active status), canCreate Invoice, etc.
    const ability = buildAbility([
      { action: 'manage', subject: 'Job' },
      { action: 'read', subject: 'Invoice' },
    ]);
    mockJobAndFinancials(); // status IN_PROGRESS → canComplete true

    renderWithProviders(<JobDetailPage />, { ability });

    await screen.findByRole('heading', { name: /J00001/ });

    // View Statement must be gone from the visible cluster
    expect(screen.queryByText('View Statement')).toBeNull();
    // Start Job must be gone
    expect(screen.queryByRole('button', { name: /start job/i })).toBeNull();
    // Mark Complete is a first-class header button, not a menu item.
    expect(screen.getByRole('button', { name: /mark complete/i })).toBeInTheDocument();
    // Status summary card label must be gone (the card is removed; StatusBadge text stays but the "Status" uppercase label card is gone)
    // There should be NO element with exactly "Status" text used as a summary-card label
    const summaryStatusLabels = screen
      .queryAllByText('Status')
      .filter((el) => el.classList.contains('uppercase'));
    expect(summaryStatusLabels).toHaveLength(0);

    // Open the consolidated Actions menu
    await userEvent.click(screen.getByRole('button', { name: /actions/i }));

    // Duplicate Job stays a menu item; Mark Complete is not duplicated into the menu.
    expect(await screen.findByText(/duplicate job/i)).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /mark complete/i })).toBeNull();
    // Unschedule must NOT be in the menu
    expect(screen.queryByText(/unschedule/i)).toBeNull();
  });
});

describe('JobDetailPage — note composer follows the API permission', () => {
  // The composer used to render for anyone who could OPEN the job, while POST /notes is
  // gated on `update Job`. A read-only viewer typed a note, got a 12px "Failed to add note",
  // and reported that notes do not save. Offer the composer only when the write will land.
  //
  // The GATE holds on the live page and is asserted below. The EXPLANATION does
  // not: `pages/JobDetailPage.tsx` rendered an "Add note" card reading "You do
  // not have permission to add notes to this job. Ask an admin to assign the job
  // to you, or to grant your role permission to edit jobs.", and the live page
  // renders nothing at all - JobNotesPreview simply omits the affordance when
  // `canAddNotes` is false. So a viewer who cannot add notes is no longer told
  // that, or told what to ask for. Whether to bring the sentence back is a
  // separate call; the assertion is dropped rather than softened so it is not
  // mistaken for coverage that still exists.
  it('hides the composer when the user cannot update the job', async () => {
    const ability = buildAbility([{ action: 'read', subject: 'Job' }]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });
    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Notes' }));

    expect(screen.queryByPlaceholderText(/write a note/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add note/i })).toBeNull();
  });

  it('renders the composer when the user can update the job', async () => {
    const ability = buildAbility([{ action: 'manage', subject: 'Job' }]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });
    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(await screen.findByRole('tab', { name: 'Notes' }));

    expect(await screen.findByPlaceholderText(/write a note/i)).toBeInTheDocument();
  });
});

describe('JobDetailPage — R3 Overview 4-column layout', () => {
  it('Overview shows Customer & Contact, Job Notes, merged Documents & Photos, Team, and AI Insights', async () => {
    const ability = buildAbility([
      { action: 'read', subject: 'Communication' },
      { action: 'manage', subject: 'Job' },
    ]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });

    await screen.findByRole('heading', { name: /J00001/ });

    // All 5 section headings must be present in the Overview tab (active by default)
    expect(await screen.findByText(/customer & contact/i)).toBeInTheDocument();
    expect(screen.getAllByText(/job notes/i).length).toBeGreaterThanOrEqual(1);
    expect(await screen.findByText(/documents & photos/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument();
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText(/ai operations insights/i)).toBeInTheDocument();
  });
});

describe('JobDetailPage — Team card', () => {
  it('shows avatars + Call/Text for dispatcher and technician (even without a phone), no status placeholder, no rating', async () => {
    mockJobAndFinancials({
      dispatcher: {
        id: 'u0000000-0000-0000-0000-000000000001',
        first_name: 'Lena',
        last_name: 'Ortiz',
        role: 'DISPATCHER',
        // no phone on file — Call/Text affordances must still render
      },
      assignees: [
        {
          user: {
            id: 'u0000000-0000-0000-0000-000000000099',
            first_name: 'Jose',
            last_name: 'Ramirez',
            role: 'TECHNICIAN',
            phone: '5125550143',
          },
        },
      ],
    } as never);

    renderWithProviders(<JobDetailPage />);

    await screen.findByRole('heading', { name: /J00001/ });

    // Scope to the Team card (names also appear in the header summary card).
    // The title now lives in a SectionCard header band, so walk up to the card
    // root (`.rounded-card`) rather than the band's immediate <div>.
    const teamCard = (await screen.findByText('Team')).closest('.rounded-card') as HTMLElement;
    const team = within(teamCard);

    // Avatar fallback initials (image is network-loaded; jsdom shows the fallback)
    expect(team.getByText('Jose Ramirez')).toBeInTheDocument();
    expect(team.getByText('JR')).toBeInTheDocument();
    expect(team.getByText('LO')).toBeInTheDocument();

    // #290: the "On-site: Unknown · ETA: Unknown" placeholder line was removed —
    // assert it stays gone until real geolocation data exists to show.
    expect(team.queryByText(/on-site: unknown/i)).toBeNull();

    // Call + Text icon actions render for BOTH the dispatcher (no phone) and the technician
    expect(team.getByLabelText('Call Lena Ortiz')).toBeInTheDocument();
    expect(team.getByLabelText('Text Lena Ortiz')).toBeInTheDocument();
    expect(team.getByLabelText('Call Jose Ramirez')).toBeInTheDocument();
    expect(team.getByLabelText('Text Jose Ramirez')).toBeInTheDocument();

    // No star/rating score anywhere in the card
    expect(team.queryByText(/\b\d\.\d\b/)).toBeNull(); // no "4.9"-style rating
  });
});

describe('JobDetailPage — Attachments tab', () => {
  it('offers attachment upload on the Attachments tab (no rail-pointing message)', async () => {
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />);

    await screen.findByRole('heading', { name: /J00001/ });

    // Click the Attachments tab
    await userEvent.click(await screen.findByRole('tab', { name: 'Attachments' }));

    // The misleading rail message must NOT be present
    expect(screen.queryByText(/upload files from the rail/i)).toBeNull();

    // An upload control must be present (file input or upload button/label)
    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
  });
});

describe('JobDetailPage — R3 "View All" Communication link', () => {
  it('clicking "View All" in the Customer & Contact card switches to the Communication tab', async () => {
    const ability = buildAbility([{ action: 'read', subject: 'Communication' }]);

    // Mock job + comms preview so the Communication History section renders
    const job = { ...BASE_JOB };
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/financials')) return { data: FINANCIALS };
      if (url.includes('/communications')) return { data: { messages: [] } };
      if (url.includes('/api/jobs/')) return { data: { job } };
      return { data: {} };
    });

    renderWithProviders(<JobDetailPage />, { ability });

    await screen.findByRole('heading', { name: /J00001/ });

    // The Communication History "View All" button must be visible
    const viewAllBtn = await screen.findByRole('button', { name: /view all/i });
    expect(viewAllBtn).toBeInTheDocument();

    // Click "View All" — must switch to the Communication tab
    await userEvent.click(viewAllBtn);

    // The Communication tab trigger must now be active. The live tab strip is
    // `pages/v2/_shared/tabs.tsx`, which exposes the real ARIA contract -
    // role="tab" plus aria-selected - rather than Radix's `data-state`, so the
    // attribute read here changed while the behaviour did not.
    const commTab = screen.getByRole('tab', { name: 'Communication' });
    expect(commTab).toHaveAttribute('aria-selected', 'true');
  });
});

// SRVW-140 - the frontend mirror of the backend `canSeePricing` predicate. It used to read
// ability.can('read','Invoice'); it now reads ability.can('read','Pricing'), the grant the Roles
// UI "See financial data" switch writes. The Payments TAB stays on read Invoice (that is an
// invoice-RECORD surface) - locked separately in job-payments-tab.test.tsx.
describe('JobDetailPage - Items tab cost/margin gate (read Pricing)', () => {
  const openItemsTab = async () => {
    await screen.findByRole('heading', { name: /J00001/ });
    await userEvent.click(screen.getByRole('tab', { name: 'Items' }));
  };

  it('hides the Internal costs card for a requester with read Invoice but no read Pricing', async () => {
    const ability = buildAbility([
      { action: 'manage', subject: 'Job' },
      { action: 'read', subject: 'Invoice' },
    ]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });
    await openItemsTab();

    expect(screen.queryByText(/internal costs/i)).toBeNull();
  });

  it('shows the Internal costs card once read Pricing is granted', async () => {
    const ability = buildAbility([
      { action: 'manage', subject: 'Job' },
      { action: 'read', subject: 'Invoice' },
      { action: 'read', subject: 'Pricing' },
    ]);
    mockJobAndFinancials();

    renderWithProviders(<JobDetailPage />, { ability });
    await openItemsTab();

    expect(await screen.findByText(/internal costs/i)).toBeInTheDocument();
  });
});
