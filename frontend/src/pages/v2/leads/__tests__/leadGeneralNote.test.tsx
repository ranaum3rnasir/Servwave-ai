/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * #3104 (B7 follow-up): the lead's general note, on the routed lead pages.
 *
 *   - The new-lead form's Notes box shows only to a person who may add a lead note (Add notes or Edit leads), and its
 *     text goes in the create request as `notes` (the server writes it as the general note).
 *   - The Edit lead form's Notes box is filled from the general note (`general_note` on the lead), never from the lead's
 *     own old `notes` column, and saving sends the box's text.
 *   - Overview has no "Lead Notes" block.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { impossibleOnPurpose } from '@/__tests__/support/backendSwitchCatalog';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { renderLeadForm } from '@/__tests__/harness/leadFormPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

stubBrowser();

// The routed id: set per test (none on the new-lead form).
let routeId: string | undefined;
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: routeId }) };
});

const mockApi = vi.mocked(api);

const CREATE_LEAD = [{ action: 'create', subject: 'Lead' }, { action: 'read', subject: 'Lead' }] as const;
// Create leads always comes with Edit leads in the switch catalog, so in the product the new-lead form always shows the box;
// the two sets below without Edit leads test the box's own rule (Add notes OR Edit leads), the Notes tab's.
const NO_EDIT = 'the Notes box rule is Add notes or Edit leads; Create leads without Edit leads isolates it';
const editor = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'update', subject: 'Lead' }]);

const formLead = (extra: object = {}) => ({
  id: LEAD_FIXTURE.id,
  lead_number: 'L00263',
  service_request: 'Garage door won\'t close',
  job_type: null,
  scheduled_start: null,
  scheduled_end: null,
  status: 'NEW',
  estimates: [],
  service_location_id: null,
  service_location: null,
  customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'Morgan', last_name: 'Diaz', ad_source: null, service_locations: [] },
  actions: ['edit'],
  ...extra,
});

function serve(lead?: unknown, held?: Promise<void>) {
  serveLeadDetail({
    lead,
    notes: NOTES_FIXTURE,
    routes: [
      // The lead's own read waits for the test to let it through (the form opened while the lead was still loading).
      ...(held && lead ? [{ match: (url: string) => url === `/api/leads/${LEAD_FIXTURE.id}`, data: () => held.then(() => ({ lead })) }] : []),
      { match: (url) => url === '/api/organization', data: { timezone: 'America/New_York', job_type_options: [], source_options: [] } },
      // The new-lead form has no lead to read: the lead's own routes answer an empty success.
      ...(lead ? [] : [{ match: (url: string) => url.includes('/api/leads/'), data: {} }]),
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routeId = undefined;
  mockApi.post.mockResolvedValue({ data: { lead: { id: LEAD_FIXTURE.id, customer_id: 'c1' } } });
  mockApi.patch.mockResolvedValue({ data: { lead: {} } });
});

describe('the new-lead form\'s Notes box', () => {
  const NEW_LEAD = ['', 'leads', 'new'].join('/');

  it.each([
    ['Edit leads', buildAbility([...CREATE_LEAD, { action: 'update', subject: 'Lead' }])],
    ['Add notes', impossibleOnPurpose(buildAbility([...CREATE_LEAD, { action: 'add_note', subject: 'Lead' }]), NO_EDIT)],
  ])('shows to a person with %s and sends its text with the new lead', async (_who, ability) => {
    serve();
    renderLeadForm({ ability, entry: NEW_LEAD });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/first name/i), 'Morgan');
    await user.type(screen.getByLabelText(/^phone/i), '5551234567');
    await user.type(screen.getByPlaceholderText('Describe the service needed...'), 'Garage door won\'t close');
    await user.type(screen.getByLabelText('Notes'), 'Customer prefers mornings.');
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const [path, body] = mockApi.post.mock.calls.find(([p]) => String(p).startsWith('/api/leads'))!;
    expect(path).toBe('/api/leads');
    expect(body).toMatchObject({ service_request: 'Garage door won\'t close', notes: 'Customer prefers mornings.' });
  });

  it('is not shown to a person without Add notes and Edit leads', async () => {
    serve();
    renderLeadForm({ ability: impossibleOnPurpose(buildAbility([...CREATE_LEAD]), NO_EDIT), entry: NEW_LEAD });
    expect(await screen.findByPlaceholderText('Describe the service needed...')).toBeInTheDocument();
    expect(screen.queryByLabelText('Notes')).toBeNull();
    expect(screen.queryByPlaceholderText('Internal notes...')).toBeNull();
  });
});

describe('the Edit lead form\'s Notes box', () => {
  const render = () => renderLeadForm({ ability: editor, entry: `/leads/${LEAD_FIXTURE.id}/edit` });

  it('opens with the general note\'s text, not the lead\'s old column, and saves the change', async () => {
    routeId = LEAD_FIXTURE.id;
    serve(formLead({ notes: 'Old column text', general_note: { id: 'n1', content: 'Customer prefers mornings.' } }));
    render();
    const box = await screen.findByLabelText('Notes');
    expect(box).toHaveValue('Customer prefers mornings.');

    const user = userEvent.setup();
    await user.clear(box);
    await user.type(box, 'Customer prefers afternoons.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}`, expect.objectContaining({ notes: 'Customer prefers afternoons.' }));
  });

  // Ran's build ruling 4: the save changes the general note only when this person changed the box.
  const saveUnchanged = async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    return mockApi.patch.mock.calls[0]![1] as Record<string, unknown>;
  };

  it.each([
    ['a general note', { id: 'n1', content: 'Customer prefers mornings.' }],
    ['no general note', null],
  ])('leaves the Notes box out of the save when it was not changed (%s)', async (_name, general_note) => {
    routeId = LEAD_FIXTURE.id;
    serve(formLead({ general_note }));
    render();
    const body = await saveUnchanged();
    expect(body).not.toHaveProperty('notes');
    expect(body).toMatchObject({ service_request: 'Garage door won\'t close' });
  });

  // The baseline is the text the box was filled with, never the live query: a refetch after the form opened (the lead
  // came from the cache, or someone else saved meanwhile) must not turn an untouched box into a change.
  const MORNINGS = { id: 'n1', content: 'Customer prefers mornings.' };
  async function openThenRefetch(newer: unknown) {
    routeId = LEAD_FIXTURE.id;
    serve(formLead({ general_note: MORNINGS }));
    const { queryClient } = render();
    expect(await screen.findByLabelText('Notes')).toHaveValue('Customer prefers mornings.');
    serve(formLead({ general_note: newer }));
    await act(() => queryClient.refetchQueries({ queryKey: ['lead', LEAD_FIXTURE.id] }));
    expect((queryClient.getQueryData(['lead', LEAD_FIXTURE.id]) as { general_note: unknown }).general_note).toEqual(newer);
    // The box keeps what it was filled with.
    expect(screen.getByLabelText('Notes')).toHaveValue('Customer prefers mornings.');
  }

  it.each([
    ['another person\'s newer text', { id: 'n1', content: 'Customer prefers afternoons.' }],
    ['the note removed elsewhere', null],
  ])('leaves an untouched box out of the save after the lead refetches with %s', async (_name, newer) => {
    await openThenRefetch(newer);
    expect(await saveUnchanged()).not.toHaveProperty('notes');
  });

  it('still sends a box the person changed after the lead refetched', async () => {
    await openThenRefetch({ id: 'n1', content: 'Customer prefers afternoons.' });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Notes'), ' Gate code 4411.');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch.mock.calls[0]![1]).toMatchObject({ notes: 'Customer prefers mornings. Gate code 4411.' });
  });

  it('leaves an untouched box out of the save when the form opened while the lead was still loading', async () => {
    routeId = LEAD_FIXTURE.id;
    let release!: () => void;
    const loaded = new Promise<void>((r) => { release = r; });
    serve(formLead({ general_note: MORNINGS }), loaded);
    render();
    expect(screen.queryByLabelText('Notes')).toBeNull();
    await act(async () => { release(); });
    expect(await screen.findByLabelText('Notes')).toHaveValue('Customer prefers mornings.');
    expect(await saveUnchanged()).not.toHaveProperty('notes');
  });

  it('sends an emptied box as a removal of the general note', async () => {
    routeId = LEAD_FIXTURE.id;
    serve(formLead({ general_note: { id: 'n1', content: 'Customer prefers mornings.' } }));
    render();
    const user = userEvent.setup();
    await user.clear(await screen.findByLabelText('Notes'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.patch.mock.calls[0]![1]).toMatchObject({ notes: null });
  });

  it('is empty when the lead has no general note, whatever the old column holds', async () => {
    routeId = LEAD_FIXTURE.id;
    serve(formLead({ notes: 'Old column text', general_note: null }));
    render();
    expect(await screen.findByLabelText('Notes')).toHaveValue('');
  });
});

describe('Overview', () => {
  it('has no "Lead Notes" block, even for a lead whose old column holds text', async () => {
    routeId = LEAD_FIXTURE.id;
    serve({ ...LEAD_FIXTURE, status: 'CONTACTED', estimates: [], notes: 'Old column text', actions: ['edit'] });
    renderLeadDetail({ ability: editor });
    expect(await screen.findByText('Service Request')).toBeInTheDocument();
    expect(screen.queryByText('Lead Notes')).toBeNull();
    expect(screen.queryByText('Old column text')).toBeNull();
  });
});
