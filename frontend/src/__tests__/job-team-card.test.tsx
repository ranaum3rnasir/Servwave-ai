import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, beforeEach } from 'vitest';
import { TeamCard } from '@/components/jobs/TeamCard';
import api from '@/lib/axios';

// Ability gate for the dispatcher Assign/Change affordance (#291). Default: no grant —
// the pre-existing display-only assertions stay meaningful.
const canMock = vi.fn().mockReturnValue(false);
vi.mock('@/contexts/AbilityContext', () => ({
  useAppAbility: () => ({ can: canMock }),
}));

// This file is about the card's layout, not its phone rules: the company has no phone service, so a crew phone
// keeps the device's own links. The phone rules are in crew-card-contact-policy.test.tsx.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

// The dispatcher dialog mounts an AssigneeSelect (react-query) — silence network.
vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn().mockResolvedValue({ data: { users: [] } }), post: vi.fn() },
}));

beforeEach(() => {
  canMock.mockReturnValue(false);
});

function renderCard(job: Omit<Parameters<typeof TeamCard>[0]['job'], 'id'>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TeamCard job={{ id: 'job-1', ...job }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderCardWithOnAssign(
  job: Omit<Parameters<typeof TeamCard>[0]['job'], 'id'>,
  onAssign: () => void,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TeamCard job={{ id: 'job-1', ...job }} onAssign={onAssign} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders technician as "HVAC Technician" and hides Call when phone is missing', () => {
  renderCard({
    dispatcher: { first_name: 'Dana', last_name: 'Brooks', phone: '5551234567' },
    salesperson: { first_name: 'Ryan', last_name: 'Cole' },
    assignees: [{ user: { first_name: 'David', last_name: 'Martinez', role: 'TECHNICIAN', department: { name: 'HVAC' }, phone: null } }],
  });
  expect(screen.getByText('HVAC Technician')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /call David/i })).toBeNull();   // tech has no phone
});

// ─── Sold By (S03.8) ────────────────────────────────────────────────────────

// The card reads the Sold By stored on the job. A job built from several estimates and a service plan
// visit job have a seller but no single estimate to walk, and a job with nobody credited shows "—"
// even when the lead it came from has an Owner (conversion copies the Owner; it is not a live link).
function soldBySection(): HTMLElement {
  return screen.getByText('Sold By').closest('section') as HTMLElement;
}

it('shows the stored Sold By, not the Owner of the lead the job came from', () => {
  renderCard({
    salesperson: { id: 'u-seller', first_name: 'Ryan', last_name: 'Cole', role: 'SALES' },
    estimate: { lead: { commission_owner: { id: 'u-owner', first_name: 'Olivia', last_name: 'Owner' } } },
    assignees: [],
  } as never);
  expect(within(soldBySection()).getByText('Ryan Cole')).toBeInTheDocument();
  expect(within(soldBySection()).queryByText('Olivia Owner')).toBeNull();
});

it('shows a dash for a job with no Sold By, even when its lead has an Owner', () => {
  renderCard({
    salesperson: null,
    estimate: { lead: { commission_owner: { id: 'u-owner', first_name: 'Olivia', last_name: 'Owner' } } },
    assignees: [],
  } as never);
  expect(within(soldBySection()).getByText('\u2014')).toBeInTheDocument();
  expect(within(soldBySection()).queryByText('Olivia Owner')).toBeNull();
});

it('titles a technician with no department as just the role', () => {
  renderCard({ assignees: [{ user: { first_name: 'Sam', last_name: 'Lee', role: 'TECHNICIAN', department: null, phone: '5550000000' } }] });
  expect(screen.getByText('Technician')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /call Sam/i })).toHaveAttribute('href', expect.stringContaining('tel:'));
});

it('shows empty-state labels when team is unassigned', () => {
  renderCard({ assignees: [] });
  expect(screen.getByText(/no technicians assigned/i)).toBeInTheDocument();
  // Without onAssign (and without the assign grant) there is no assign affordance at all
  expect(screen.queryByRole('button', { name: /assign/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /add technician/i })).toBeNull();
});

it('does not render the placeholder status line on assigned-technician rows', () => {
  renderCard({
    assignees: [{ user: { first_name: 'David', last_name: 'Martinez', role: 'TECHNICIAN', phone: '5551112222' } }],
  });
  expect(screen.queryByText(/On-site: Unknown/i)).toBeNull();
  expect(screen.queryByText(/ETA: Unknown/i)).toBeNull();
});

it('shows an Assign action in the section header when onAssign is provided (technicians assigned)', () => {
  const onAssign = vi.fn();
  renderCardWithOnAssign(
    { assignees: [{ user: { first_name: 'David', last_name: 'Martinez', role: 'TECHNICIAN', phone: '5551112222' } }] },
    onAssign,
  );
  // Scoped to the crew section: `onAssign` also enables the DISPATCHER affordance now (see the
  // canAssign note below), and both controls are labelled "Assign".
  const crew = screen.getByText('Assigned Technicians').closest('section') as HTMLElement;
  fireEvent.click(within(crew).getByRole('button', { name: /assign/i }));
  expect(onAssign).toHaveBeenCalledTimes(1);
});

it('shows a "+ Add technician" affordance in the empty state when onAssign is provided', () => {
  const onAssign = vi.fn();
  renderCardWithOnAssign({ assignees: [] }, onAssign);
  const addBtn = screen.getByRole('button', { name: /add technician/i });
  fireEvent.click(addBtn);
  expect(onAssign).toHaveBeenCalledTimes(1);
});

// ─── Dispatcher assign affordance (#291) ────────────────────────────────────

// The dispatcher affordance keys on `onAssign`, NOT on `ability.can('assign','Job')`. Since the
// technician-ownership spec (Part C) scoped `assign Job` to `created_by_id`, the subject-level
// ability question is true for every technician and cannot see WHICH job is on screen - it offered
// this control on jobs the API refuses. The parent (JobDetailPage) already computes the per-instance
// answer with canOnJob and passes it as `onAssign`; the card consumes that instead of re-deriving.
it('renders an "Assign" dispatcher affordance when the parent says this job is assignable', () => {
  renderCardWithOnAssign({ dispatcher: null, assignees: [] }, vi.fn());
  const dispatcherSection = screen.getByText('Dispatcher').closest('section') as HTMLElement;
  expect(within(dispatcherSection).getByRole('button', { name: 'Assign' })).toBeInTheDocument();
});

it('ignores a permissive subject-level ability when the parent withheld onAssign', () => {
  // The regression this rewrite exists to prevent: a technician holding a creator-scoped
  // `assign Job` grant, looking at a job somebody else created.
  canMock.mockReturnValue(true);
  renderCard({ dispatcher: null, assignees: [] });
  expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
});

it('hides the dispatcher affordance when the parent withheld onAssign', () => {
  renderCard({ dispatcher: null, assignees: [] });
  expect(screen.queryByRole('button', { name: 'Assign' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Change' })).toBeNull();
});

it('labels the dispatcher affordance "Change" when a dispatcher is set', () => {
  renderCardWithOnAssign(
    {
      dispatcher: { id: 'u-disp', first_name: 'Dana', last_name: 'Brooks', role: 'DISPATCHER', phone: '5551234567' },
      assignees: [],
    },
    vi.fn(),
  );
  expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
});

it('opens the dispatcher dialog from the affordance', () => {
  renderCardWithOnAssign({ dispatcher: null, assignees: [] }, vi.fn());
  const dispatcherSection = screen.getByText('Dispatcher').closest('section') as HTMLElement;
  fireEvent.click(within(dispatcherSection).getByRole('button', { name: 'Assign' }));
  expect(screen.getByText('Assign Dispatcher')).toBeInTheDocument();
  expect(screen.getByText('Only people who can be a dispatcher are listed.')).toBeInTheDocument();
  expect(screen.queryByText(/only dispatchers and admins/i)).toBeNull();
});

// ─── Sold By assign / change / clear (S03.11) ───────────────────────────────

// Sold By rides the same switch as the Dispatcher (Assign people to jobs), so the card shows its control
// on exactly the answer the parent already gave for this job: `onAssign`.
describe('Sold By control', () => {
  const mockApi = vi.mocked(api);

  beforeEach(() => {
    mockApi.get.mockReset();
    mockApi.get.mockResolvedValue({ data: [] });
    mockApi.post.mockReset();
    mockApi.post.mockResolvedValue({ data: {} });
  });

  const seller = { id: 'u-seller', first_name: 'Ryan', last_name: 'Cole', role: 'SALES' };

  it('offers "Assign" on an empty Sold By and "Change" on a filled one when the parent says this job is assignable', () => {
    const { unmount } = renderCardWithOnAssign({ salesperson: null, assignees: [] }, vi.fn());
    expect(within(soldBySection()).getByRole('button', { name: 'Assign' })).toBeInTheDocument();
    unmount();

    renderCardWithOnAssign({ salesperson: seller, assignees: [] }, vi.fn());
    expect(within(soldBySection()).getByRole('button', { name: 'Change' })).toBeInTheDocument();
  });

  it('hides the control when the parent withheld onAssign, whatever the subject-level ability says', () => {
    canMock.mockReturnValue(true);
    renderCard({ salesperson: seller, assignees: [] });
    expect(within(soldBySection()).queryByRole('button')).toBeNull();
  });

  it('opens a dialog that says only people who can be Sold By are listed, and asks the roster for that slot', async () => {
    renderCardWithOnAssign({ salesperson: null, assignees: [] }, vi.fn());
    fireEvent.click(within(soldBySection()).getByRole('button', { name: 'Assign' }));

    expect(screen.getByText('Assign Sold By')).toBeInTheDocument();
    expect(screen.getByText('Only people who can be Sold By are listed.')).toBeInTheDocument();
    await waitFor(() => {
      const rosterCalls = mockApi.get.mock.calls.filter(([url]) => url === '/api/users/assignable');
      expect(rosterCalls.length).toBeGreaterThan(0);
      expect((rosterCalls[0]![1] as { params: Record<string, string> }).params).toMatchObject({ eligible_for: 'owner' });
    });
  });

  it('titles the dialog "Change Sold By" when a seller is set, and clears the Sold By from it', async () => {
    renderCardWithOnAssign({ salesperson: seller, assignees: [] }, vi.fn());
    fireEvent.click(within(soldBySection()).getByRole('button', { name: 'Change' }));
    expect(screen.getByText('Change Sold By')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear Sold By' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/sold-by', { sold_by_id: null }));
  });

  it('does not offer to clear an empty Sold By', () => {
    renderCardWithOnAssign({ salesperson: null, assignees: [] }, vi.fn());
    fireEvent.click(within(soldBySection()).getByRole('button', { name: 'Assign' }));
    expect(screen.queryByRole('button', { name: 'Clear Sold By' })).toBeNull();
  });

  it('keeps the Dispatcher dialog on its own endpoint', async () => {
    renderCardWithOnAssign({ dispatcher: { id: 'u-disp', first_name: 'Dana', last_name: 'Brooks', role: 'DISPATCHER' }, assignees: [] }, vi.fn());
    // No seller on this job, so the only "Change" on the card is the Dispatcher's.
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear dispatcher' }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/jobs/job-1/dispatcher', { dispatcher_id: null }));
  });
});
