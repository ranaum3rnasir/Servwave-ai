/**
 * Roles & Permissions, PRD 3, slice S03.17 - the new-job form books visit 1 with the creator on its crew. Next to
 * the booking time sits an "I'll do this visit" checkbox: checked by default for a person with Assign people to jobs
 * off, unchecked for a holder, hidden for a person who can't be on a crew (their own switch, as the server answers
 * it). Nobody else can be named on visit 1 here. A clash with the creator's other work is shown with "Schedule
 * anyway", and a creator who is now on the crew lands on the job they made. Rendered through the routed form over a
 * mocked HTTP layer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import { buildAbility } from '@/lib/ability';
import { formatDateForInput } from '@/lib/date-input';
import { useAuthStore } from '@/stores/auth.store';
import { toast } from '@/ui-kit/components/ui/sonner';

type AuthState = ReturnType<typeof useAuthStore.getState>;

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], timezone: 'America/New_York' } }),
}));
// The routed page reports through the kit's toaster, which the test render does not mount.
vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const NEW_JOB = { id: 'e0000000-0000-0000-0000-0000000000cc', job_number: 'J-100' };

const mockApi = vi.mocked(api);
// Create jobs needs View and Edit jobs.
const canCreate = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'read', subject: 'Job' },
  { action: 'update', subject: 'Job' },
]);
const canCreateAndAssign = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'read', subject: 'Job' },
  { action: 'update', subject: 'Job' },
  { action: 'assign', subject: 'Job' },
  { action: 'read', subject: 'User' },
]);

/** What the server answers for the pre-fill: the creator rule's result and whether this person can be on a crew. */
function serverAnswers(opts: { canBeOnCrew: boolean }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/jobs/creator-prefill') {
      return { data: { prefill: { sold_by_id: CREATOR.id, dispatcher_id: null }, can_be_on_crew: opts.canBeOnCrew } };
    }
    if (url === '/api/users/assignable') return { data: [] };
    return { data: {} };
  });
}

function renderForm(ability: ReturnType<typeof buildAbility>) {
  return renderWithProviders(<JobFormPage />, { ability, initialEntries: ['/jobs/new'] });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/first name/i), 'Pat');
  await user.type(screen.getByLabelText(/^phone/i), '5551234567');
  await user.type(screen.getByLabelText(/address/i), '1 Test Way');
  await user.type(screen.getByLabelText(/^city/i), 'Testville');
  await user.type(screen.getByLabelText(/^state/i), 'MA');
  await user.type(screen.getByLabelText(/^zip/i), '02108');
  await user.type(screen.getByLabelText(/service request/i), 'Fix the door');
}

const scheduleSwitch = () => screen.getByRole('switch', { name: 'Schedule this job now' });

/** Turn "Schedule this job now" on and give the visit a day and a start time. */
async function scheduleOnDay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(scheduleSwitch());
  await user.type(screen.getByLabelText(/start date/i), formatDateForInput('2031-05-14'));
  await user.tab();
  await user.type(screen.getByLabelText(/start time/i), '9:00 AM');
  await user.tab();
}

const iDoIt = () => screen.queryByRole('checkbox', { name: "I'll do this visit" });

/** The body of the one job the form posted. */
const postedJob = () => {
  const call = mockApi.post.mock.calls.find(([url]) => String(url).startsWith('/api/jobs'));
  return call?.[1] as Record<string, unknown> | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.mocked(useAuthStore).mockImplementation((selector: (s: AuthState) => unknown) =>
    selector({ user: { ...CREATOR, email: 'casey@example.com', role: 'TECHNICIAN', organization_id: 'org-1' } } as AuthState),
  );
  serverAnswers({ canBeOnCrew: true });
  mockApi.post.mockResolvedValue({ data: { job: NEW_JOB, job_openable: true } });
});

describe('the "I\'ll do this visit" checkbox', () => {
  it('sits with the booking time: not there while "Schedule this job now" is off, there once it is on', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    expect(iDoIt()).toBeNull();

    await user.click(scheduleSwitch());
    expect(iDoIt()).toBeInTheDocument();
  });

  it('is checked by default for a person without Assign people to jobs', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await user.click(scheduleSwitch());

    expect(iDoIt()).toBeChecked();
  });

  it('is unchecked by default for a holder of Assign people to jobs', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await screen.findByRole('combobox', { name: 'Sold By' });
    await user.click(scheduleSwitch());

    expect(iDoIt()).not.toBeChecked();
  });

  it('is hidden for a person who can\'t be on a crew, however the form is otherwise set up', async () => {
    const user = userEvent.setup();
    serverAnswers({ canBeOnCrew: false });
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await user.click(scheduleSwitch());

    expect(iDoIt()).toBeNull();
  });

  it('offers no way to name anyone else on visit 1', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await screen.findByRole('combobox', { name: 'Sold By' });
    await user.click(scheduleSwitch());

    expect(screen.queryByRole('combobox', { name: /crew|performers|assign|technician/i })).toBeNull();
  });
});

describe('what the form posts', () => {
  it('puts only the creator on visit 1 when the box is checked and a time is set', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).toMatchObject({ visit_assignee_ids: [CREATOR.id] });
    expect(postedJob()!.scheduled_start).toBeTruthy();
    expect(postedJob()).not.toHaveProperty('visit_force');
  });

  it('posts a holder\'s tick, and nothing when they leave the box alone', async () => {
    const user = userEvent.setup();
    renderForm(canCreateAndAssign);
    await screen.findByRole('combobox', { name: 'Sold By' });
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(iDoIt()!);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).toMatchObject({ visit_assignee_ids: [CREATOR.id] });
  });

  it('posts no crew when the box is unchecked', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(iDoIt()!);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).not.toHaveProperty('visit_assignee_ids');
    expect(postedJob()!.scheduled_start).toBeTruthy();
  });

  it('posts no crew when the person can\'t be on a crew, though the box would have defaulted to checked', async () => {
    const user = userEvent.setup();
    serverAnswers({ canBeOnCrew: false });
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).not.toHaveProperty('visit_assignee_ids');
  });

  it('posts no crew without a booking time, and none while "Schedule this job now" is off', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(postedJob()).toBeDefined());
    expect(postedJob()).not.toHaveProperty('visit_assignee_ids');
    expect(postedJob()!.scheduled_start).toBeUndefined();
  });

  it('does not save before the form knows whether the person can be on a crew', async () => {
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    renderForm(canCreate);

    expect(screen.getByRole('button', { name: /create job/i })).toBeDisabled();
  });
});

describe('a clash with the creator\'s other work', () => {
  it('says so, saves nothing, and offers to schedule anyway, which posts the override', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: 'Schedule conflict detected',
          conflicts: [{ type: 'job', id: 'j-1', number: 'J-0042', start: '2031-05-14T14:00:00.000Z', end: '2031-05-14T15:00:00.000Z' }],
        },
      },
    });
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    expect(await screen.findByText('Scheduling conflict')).toBeInTheDocument();
    expect(screen.getByText('J-0042')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The raw refusal is not also printed.
    expect(screen.queryByText('Schedule conflict detected')).toBeNull();

    await user.click(screen.getByRole('button', { name: /schedule anyway/i }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    expect(mockApi.post.mock.calls[1]![1]).toMatchObject({ visit_force: true, visit_assignee_ids: [CREATOR.id] });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });

  it('is retired when the person unticks the box, so a later save is not forced', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Schedule conflict detected', conflicts: [{ type: 'job', id: 'j-1', number: 'J-0042', start: '2031-05-14T14:00:00.000Z', end: '2031-05-14T15:00:00.000Z' }] } },
    });
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));
    await screen.findByText('Scheduling conflict');

    await user.click(iDoIt()!);
    expect(screen.queryByText('Scheduling conflict')).toBeNull();
  });
});

describe('after saving', () => {
  it('lands the creator on the job they made, which they are now on the crew of', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await screen.findByText('Casey Creator');
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate.mock.calls[0]![0]).toBe(`/jobs/${NEW_JOB.id}`);
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled();
  });
});
