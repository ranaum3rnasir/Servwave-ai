/**
 * Roles & Permissions, PRD 3, slice S03.18 - the new-lead form books a real walkthrough, with a Performers
 * picker. The "Schedule walkthrough" time is booked as a walkthrough visit by the server; beside it sits a
 * Performers picker of its own for a person with Book walkthroughs (it starts empty), and an "I'll do this
 * walkthrough" checkbox for anyone else (checked by default, hidden when they can't be on a crew). Rendered
 * through the routed form over a mocked HTTP layer: what the person sees, and what the form posts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { formatDateForInput } from '@/lib/date-input';
import { DEFAULT_SCHEDULE_TIMEZONE, isoToOrgDay } from '@/lib/schedule-tz';
import { useAuthStore } from '@/stores/auth.store';
import { renderLeadForm, serveLeadForm } from '@/__tests__/harness/leadFormPage';

type AuthState = ReturnType<typeof useAuthStore.getState>;

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));

const CREATOR = { id: 'u-creator', first_name: 'Casey', last_name: 'Creator' };
const CREW = [
  { id: 'u-crew-a', first_name: 'Cleo', last_name: 'Crew', role: 'TECHNICIAN', department: null },
  { id: 'u-crew-b', first_name: 'Cal', last_name: 'Carries', role: 'SALES', department: null },
];

const mockApi = vi.mocked(api);
// Create leads alone, and with Book walkthroughs (the grant behind that switch).
// Create leads needs View and Edit leads; Book walkthroughs needs View leads.
const canCreate = buildAbility([
  { action: 'create', subject: 'Lead' },
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
]);
const canBook = buildAbility([
  { action: 'create', subject: 'Lead' },
  { action: 'schedule_walkthrough', subject: 'Lead' },
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Lead' },
]);

/** The creator rule's answer and whether the signed-in person can be on a crew, as the server serves them. */
function serverAnswers(opts: { canBeOnCrew: boolean }) {
  serveLeadForm({
    creatorPrefill: { prefill: { owner_id: CREATOR.id, dispatcher_id: null }, can_be_on_crew: opts.canBeOnCrew },
    assignable: (params) => (params.eligible_for === 'crew' ? CREW : []),
  });
}

function renderForm(ability: ReturnType<typeof buildAbility>) {
  return renderLeadForm({ ability, entry: '/leads/create' });
}

async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/first name/i), 'Pat');
  await user.type(screen.getByLabelText(/^phone/i), '5551234567');
  await user.type(screen.getByLabelText(/service request/i), 'Fix the door');
}

/** Turn "Schedule walkthrough" on and give it a day. */
async function scheduleOnDay(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('switch', { name: 'Schedule walkthrough' }));
  await user.type(screen.getByLabelText('Start Date'), formatDateForInput('2031-05-14'));
  await user.tab();
}

const performersPicker = () => screen.getByRole('combobox', { name: 'Performers' });
const iDoIt = () => screen.queryByRole('checkbox', { name: "I'll do this walkthrough" });

/** The body of the one lead the form posted. */
const postedLead = () => {
  const call = mockApi.post.mock.calls.find(([url]) => String(url).startsWith('/api/leads'));
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
  mockApi.post.mockResolvedValue({ data: { lead: { id: 'e0000000-0000-0000-0000-0000000000cc', customer_id: 'c1' } } });
});

describe('a person with Book walkthroughs', () => {
  it('gets a Performers picker beside the time, empty to start with, and no "I\'ll do this walkthrough" checkbox', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await user.click(screen.getByRole('switch', { name: 'Schedule walkthrough' }));

    expect(await screen.findByRole('combobox', { name: 'Performers' })).toBeInTheDocument();
    expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
    expect(iDoIt()).toBeNull();
    // Empty to start with: not even the creator is in it.
    await waitFor(() => expect(performersPicker()).toHaveTextContent('Add performer...'));
  });

  it('asks for the people who can be on a crew', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await user.click(screen.getByRole('switch', { name: 'Schedule walkthrough' }));
    await screen.findByRole('combobox', { name: 'Performers' });

    await waitFor(() => {
      const asked = mockApi.get.mock.calls
        .filter(([url]) => url === '/api/users/assignable')
        .map(([, config]) => (config as { params: Record<string, unknown> }).params);
      expect(asked).toContainEqual(expect.objectContaining({ purpose: 'walkthroughPerformer', eligible_for: 'crew' }));
    });
  });

  it('posts the time with the performers they picked', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(await screen.findByRole('combobox', { name: 'Performers' }));
    await user.click(await screen.findByRole('option', { name: 'Cleo Crew' }));
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    // The day they typed, at the organisation's clock.
    expect(isoToOrgDay(String(postedLead()!.scheduled_start), DEFAULT_SCHEDULE_TIMEZONE)).toBe('2031-05-14');
    expect(postedLead()!.walkthrough_performer_ids).toEqual(['u-crew-a']);
  });

  it('posts a time with nobody on it when they pick no one', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toEqual(expect.any(String));
    expect(postedLead()!.walkthrough_performer_ids).toEqual([]);
  });

  it('posts no walkthrough, and no performers, when there is no time and nobody was picked', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await fillRequiredFields(user);
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toBeUndefined();
    expect(postedLead()).not.toHaveProperty('walkthrough_performer_ids');
  });

  it('shows the Performers picker with "Schedule walkthrough" off, empty to start with (performers can be saved without a time)', async () => {
    renderForm(canBook);

    expect(await screen.findByRole('combobox', { name: 'Performers' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Schedule walkthrough' })).not.toBeChecked();
    expect(screen.queryByLabelText('Start Date')).toBeNull();
    expect(iDoIt()).toBeNull();
    await waitFor(() => expect(performersPicker()).toHaveTextContent('Add performer...'));
  });

  it('posts the performers they picked with no time at all', async () => {
    const user = userEvent.setup();
    renderForm(canBook);
    await fillRequiredFields(user);
    await user.click(await screen.findByRole('combobox', { name: 'Performers' }));
    await user.click(await screen.findByRole('option', { name: 'Cleo Crew' }));
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toBeUndefined();
    expect(postedLead()!.walkthrough_performer_ids).toEqual(['u-crew-a']);
  });
});

describe('a person without Book walkthroughs', () => {
  it('gets an "I\'ll do this walkthrough" checkbox, checked by default, instead of the picker', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await user.click(screen.getByRole('switch', { name: 'Schedule walkthrough' }));

    expect(await screen.findByRole('checkbox', { name: "I'll do this walkthrough" })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Performers' })).toBeNull();
  });

  it('posts only themselves as the performer while it is checked', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await screen.findByRole('checkbox', { name: "I'll do this walkthrough" });
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.walkthrough_performer_ids).toEqual([CREATOR.id]);
  });

  it('posts a time with nobody on it once they uncheck it', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(await screen.findByRole('checkbox', { name: "I'll do this walkthrough" }));
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toEqual(expect.any(String));
    expect(postedLead()!.walkthrough_performer_ids).toEqual([]);
  });

  it('sees the checkbox with "Schedule walkthrough" off, and posts only themselves with no time while it is checked', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await fillRequiredFields(user);
    expect(await screen.findByRole('checkbox', { name: "I'll do this walkthrough" })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Schedule walkthrough' })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toBeUndefined();
    expect(postedLead()!.walkthrough_performer_ids).toEqual([CREATOR.id]);
  });

  it('posts no walkthrough at all once they uncheck it and give no time', async () => {
    const user = userEvent.setup();
    renderForm(canCreate);
    await fillRequiredFields(user);
    await user.click(await screen.findByRole('checkbox', { name: "I'll do this walkthrough" }));
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.scheduled_start).toBeUndefined();
    expect(postedLead()).not.toHaveProperty('walkthrough_performer_ids');
  });

  it('does not see the checkbox when they cannot be on a crew, and still books the time with nobody on it', async () => {
    const user = userEvent.setup();
    serverAnswers({ canBeOnCrew: false });
    renderForm(canCreate);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/api/leads/creator-prefill'));
    expect(iDoIt()).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Performers' })).toBeNull();
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(postedLead()).toBeDefined());
    expect(postedLead()!.walkthrough_performer_ids).toEqual([]);
  });
});

describe('a clash with a performer\'s other work', () => {
  it('says so, saves nothing, and offers to schedule anyway', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: 'Schedule conflict detected',
          conflicts: [{ type: 'walkthrough', id: 'l-1', number: 'LD-0042', start: '2031-05-14T14:00:00.000Z', end: '2031-05-14T15:00:00.000Z' }],
        },
      },
    });
    renderForm(canBook);
    await fillRequiredFields(user);
    await scheduleOnDay(user);
    await user.click(await screen.findByRole('combobox', { name: 'Performers' }));
    await user.click(await screen.findByRole('option', { name: 'Cleo Crew' }));
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    expect(await screen.findByText('Scheduling conflict')).toBeInTheDocument();
    expect(screen.getByText('LD-0042')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
    // The raw refusal is not also printed.
    expect(screen.queryByText('Schedule conflict detected')).toBeNull();

    await user.click(screen.getByRole('button', { name: /schedule anyway/i }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
    const second = mockApi.post.mock.calls[1]![1] as Record<string, unknown>;
    expect(second).toMatchObject({ walkthrough_force: true, walkthrough_performer_ids: ['u-crew-a'] });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
  });
});
