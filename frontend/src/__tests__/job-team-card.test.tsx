import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi, beforeEach } from 'vitest';
import { TeamCard } from '@/components/jobs/TeamCard';

// Ability gate for the dispatcher Assign/Change affordance (#291). Default: no grant —
// the pre-existing display-only assertions stay meaningful.
const canMock = vi.fn().mockReturnValue(false);
vi.mock('@/contexts/AbilityContext', () => ({
  useAppAbility: () => ({ can: canMock }),
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
      <TeamCard job={{ id: 'job-1', ...job }} />
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
      <TeamCard job={{ id: 'job-1', ...job }} onAssign={onAssign} />
    </QueryClientProvider>,
  );
}

it('renders technician as "HVAC Technician" and hides Call when phone is missing', () => {
  renderCard({
    dispatcher: { first_name: 'Dana', last_name: 'Brooks', phone: '5551234567' },
    estimate: { lead: { commission_owner: { first_name: 'Ryan', last_name: 'Cole' } } },
    assignees: [{ user: { first_name: 'David', last_name: 'Martinez', role: 'TECHNICIAN', department: { name: 'HVAC' }, phone: null } }],
  });
  expect(screen.getByText('HVAC Technician')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /call David/i })).toBeNull();   // tech has no phone
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
  expect(screen.getByText(/only dispatchers and admins/i)).toBeInTheDocument();
});
