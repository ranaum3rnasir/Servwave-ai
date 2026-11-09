/**
 * A creator's own lead: edit with field limits (Roles & Permissions, PRD 4, S04.18), on the ROUTED lead pages.
 *
 * The lead detail response carries the actions the server says this person may take on THAT lead. A lead's creator
 * without Edit leads is offered the plain edit and nothing more: no source, no walkthrough times, no service
 * location, no status. The pages show only what the list offers, and the edit form does not send what it hides.
 * A response without the list (an older server) falls back to the person's grants, as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { LEAD_FIXTURE, NOTES_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { renderLeadForm } from '@/__tests__/harness/leadFormPage';

vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));
vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: ['Repair'], source_options: ['Referral'] } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

stubBrowser();

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useParams: () => ({ id: LEAD_FIXTURE.id }), useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

// The creator holds no Edit leads: they can open the lead and nothing more. A holder has Edit leads.
const creatorAbility = buildAbility([{ action: 'read', subject: 'Lead' }]);
// Assign keeps the actions menu from being empty, so a missing Edit is a real absence.
const holderAbility = buildAbility([{ action: 'read', subject: 'Lead' }, { action: 'update', subject: 'Lead' }, { action: 'assign', subject: 'Lead' }]);

const MIAMI = {
  id: 'l0000000-0000-0000-0000-0000000000f1',
  address_line1: '500 Ocean Drive',
  address_line2: null,
  city: 'Miami',
  state: 'FL',
  zip: '33139',
  is_primary: true,
};

const detailLead = (extra: object = {}) => ({ ...LEAD_FIXTURE, status: 'CONTACTED', estimates: [], ...extra });

const formLead = (extra: object = {}) => ({
  id: LEAD_FIXTURE.id,
  lead_number: 'L00263',
  service_request: 'Fix the door',
  notes: null,
  job_type: null,
  scheduled_start: null,
  scheduled_end: null,
  status: 'NEW',
  estimates: [],
  service_location_id: MIAMI.id,
  service_location: MIAMI,
  customer: { id: 'c0000000-0000-0000-0000-0000000000aa', first_name: 'Pat', last_name: 'Payer', ad_source: null, service_locations: [MIAMI] },
  ...extra,
});

function serve(lead: unknown) {
  serveLeadDetail({ lead, notes: NOTES_FIXTURE });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: { lead: {} } });
});

describe('the lead page, from the lead\'s action list', () => {
  const openKebab = async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(await screen.findByRole('button', { name: /Lead actions/i }));
    return screen.findAllByRole('menuitem');
  };
  const names = (items: HTMLElement[]) => items.map((i) => i.textContent?.trim());

  it('offers Edit to a creator without Edit leads when the server lists it', async () => {
    serve(detailLead({ actions: ['edit'] }));
    renderLeadDetail({ ability: creatorAbility });
    expect(names(await openKebab())).toContain('Edit');
  });

  it('offers no Edit when the server lists none, even to a person whose grants hold Edit leads', async () => {
    serve(detailLead({ actions: [] }));
    renderLeadDetail({ ability: holderAbility });
    expect(names(await openKebab())).not.toContain('Edit');
  });

  it('keeps the status menu closed to a creator, who is offered the edit but not the status', async () => {
    serve(detailLead({ actions: ['edit'] }));
    renderLeadDetail({ ability: holderAbility });
    // A status the person may not set is shown, not offered as a menu.
    await screen.findByText('Contacted');
    expect(screen.queryByRole('button', { name: /lead status: contacted/i })).toBeNull();
  });

  it('opens the status menu when the server lists the status', async () => {
    serve(detailLead({ actions: ['edit', 'edit_address', 'edit_source', 'edit_schedule', 'change_status'] }));
    renderLeadDetail({ ability: holderAbility });
    expect(await screen.findByRole('button', { name: /lead status: contacted/i })).toBeInTheDocument();
  });

  it('shows the tags without the add or remove controls when the server lists no edit', async () => {
    serve(detailLead({ actions: [], tags: [{ id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' }] }));
    renderLeadDetail({ ability: holderAbility });
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove tag urgent/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^tag$/i })).toBeNull();
  });

  it('offers the tag controls when the server lists the edit', async () => {
    serve(detailLead({ actions: ['edit'], tags: [{ id: 'a0000000-0000-0000-0000-000000000001', name: 'Urgent', color: '#EF4444' }] }));
    renderLeadDetail({ ability: creatorAbility });
    expect(await screen.findByRole('button', { name: /remove tag urgent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^tag$/i })).toBeInTheDocument();
  });

  it('falls back to the grants when the response carries no list', async () => {
    serve(detailLead());
    renderLeadDetail({ ability: holderAbility });
    expect(await screen.findByRole('button', { name: /lead status: contacted/i })).toBeEnabled();
    expect(names(await openKebab())).toContain('Edit');
  });
});

describe('the edit form, from the lead\'s action list', () => {
  const FULL = ['edit', 'edit_address', 'edit_source', 'edit_schedule', 'change_status'];
  const render = () => renderLeadForm({ ability: creatorAbility, entry: `/leads/${LEAD_FIXTURE.id}/edit` });
  const save = async () => {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
  };

  it('shows a creator no source, no walkthrough times, and the address only as locked text', async () => {
    serve(formLead({ actions: ['edit'] }));
    render();
    expect(await screen.findByLabelText('Service Request *')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    expect(screen.queryByRole('switch', { name: /schedule walkthrough/i })).toBeNull();
    expect(screen.getByText('500 Ocean Drive')).toBeInTheDocument();
    expect(screen.getByText(/only people who can edit leads can change the service location/i)).toBeInTheDocument();
  });

  it('sends a creator\'s save with the plain details only', async () => {
    serve(formLead({ actions: ['edit'] }));
    render();
    await save();
    expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}`, { service_request: 'Fix the door', job_type: null });
  });

  it('saves a creator\'s edit even when the stored address on the lead is incomplete', async () => {
    serve(formLead({
      actions: ['edit'], service_location_id: null, service_location: null, service_address_line1: '12 Old Road', service_city: null, service_state: 'New Jersey',
      customer: { id: 'c1', first_name: 'Pat', last_name: 'Payer', ad_source: null, service_locations: [] },
    }));
    render();
    await save();
    expect(mockApi.patch).toHaveBeenCalledWith(`/api/leads/${LEAD_FIXTURE.id}`, { service_request: 'Fix the door', job_type: null });
  });

  it('shows and sends everything to a person the list offers every field', async () => {
    serve(formLead({ actions: FULL }));
    render();
    expect(await screen.findByRole('combobox', { name: 'Source' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /schedule walkthrough/i })).toBeInTheDocument();
    await save();
    expect(mockApi.patch).toHaveBeenCalledWith(
      `/api/leads/${LEAD_FIXTURE.id}`,
      expect.objectContaining({ ad_source: null, scheduled_start: null, scheduled_end: null, service_location_id: MIAMI.id }),
    );
  });

  it('shows everything when the response carries no list', async () => {
    serve(formLead());
    render();
    expect(await screen.findByRole('combobox', { name: 'Source' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /schedule walkthrough/i })).toBeInTheDocument();
  });
});
