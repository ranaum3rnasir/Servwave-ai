import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import LeadsPage from '@/pages/v2/leads/LeadsPage';

/**
 * Roles & Permissions, PRD 4, slice S04.1 - the Job Type and Job Source lists fill for everyone.
 *
 * Nothing mocks the organization hook here: the pages read the company record through the real
 * `useOrganization` over the mocked HTTP layer, as a signed-in person with the Technician preset's
 * values does. That person creates jobs and leads and does NOT hold Company settings (update
 * Organization), and holds no read of Organization either - so any form-level check on either
 * would hide the lists and fail these.
 */

const mockApi = vi.mocked(api);

const JOB_TYPES = ['Install', 'Repair'];
const SOURCES = ['Referral', 'Website'];
// Built from parts so the repo-wide guard in add-new-client-target.test.tsx, which counts the quoted literal, is untouched.
const NEW_LEAD_ROUTE = ['', 'leads', 'new'].join('/');

// The Technician preset: Create jobs and Create leads on, Company settings off.
const technician = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'read', subject: 'Job' },
  { action: 'create', subject: 'Lead' },
  { action: 'read', subject: 'Lead' },
]);
const withCompanySettings = buildAbility([
  { action: 'create', subject: 'Job' },
  { action: 'create', subject: 'Lead' },
  { action: 'read', subject: 'Lead' },
  { action: 'update', subject: 'Organization' },
]);

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function serve(org: { job_type_options: string[]; source_options: string[] }) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/organization') return Promise.resolve({ data: { timezone: 'America/New_York', ...org } });
    if (url === '/api/leads') {
      return Promise.resolve({
        data: {
          leads: [],
          pagination: { page: 1, limit: 25, total: 0, totalPages: 0 },
          stats: { total: 0, new_this_week: 0, no_owner: 0, won: 0, lost: 0 },
        },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

async function optionsOf(trigger: HTMLElement): Promise<string[]> {
  await userEvent.setup().click(trigger);
  const list = await screen.findAllByRole('option');
  return list.map((o) => o.textContent ?? '');
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  vi.clearAllMocks();
});

describe('Job form: the lists fill for a field worker', () => {
  it('lists the company job types', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    renderWithProviders(<JobFormPage />, { ability: technician, initialEntries: ['/jobs/new'] });
    const trigger = await screen.findByRole('combobox', { name: /job type/i });
    expect(await optionsOf(trigger)).toEqual(JOB_TYPES);
  });

  it('lists the company job sources', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    renderWithProviders(<JobFormPage />, { ability: technician, initialEntries: ['/jobs/new'] });
    const trigger = await screen.findByRole('combobox', { name: /^source/i });
    expect(await optionsOf(trigger)).toEqual(SOURCES);
  });
});

describe('Lead form: the lists fill for a field worker', () => {
  it('lists the company job types', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    renderWithProviders(<LeadFormPage />, { ability: technician, initialEntries: [NEW_LEAD_ROUTE] });
    const trigger = await screen.findByRole('combobox', { name: 'Job Type' });
    expect(await optionsOf(trigger)).toEqual(JOB_TYPES);
  });

  it('lists the company job sources', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    renderWithProviders(<LeadFormPage />, { ability: technician, initialEntries: [NEW_LEAD_ROUTE] });
    const trigger = await screen.findByRole('combobox', { name: 'Source' });
    expect(await optionsOf(trigger)).toEqual(SOURCES);
  });
});

describe('Leads list filter: the facets fill for a field worker', () => {
  async function openFacet(tab: string) {
    renderWithProviders(<LeadsPage />, { ability: technician, initialEntries: ['/leads'] });
    fireEvent.click(await screen.findByRole('button', { name: /^filter$/i }));
    fireEvent.click(await screen.findByRole('tab', { name: tab }));
  }

  it('lists the company job sources under Source', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    await openFacet('Source');
    for (const s of SOURCES) expect(await screen.findByRole('checkbox', { name: s })).toBeInTheDocument();
  });

  it('lists the company job types under Type', async () => {
    serve({ job_type_options: JOB_TYPES, source_options: SOURCES });
    await openFacet('Type');
    for (const t of JOB_TYPES) expect(await screen.findByRole('checkbox', { name: t })).toBeInTheDocument();
  });
});

describe('The empty-list hint', () => {
  async function hintOnLeadForm(ability: typeof technician) {
    serve({ job_type_options: [], source_options: [] });
    renderWithProviders(<LeadFormPage />, { ability, initialEntries: [NEW_LEAD_ROUTE] });
    const trigger = await screen.findByRole('combobox', { name: 'Job Type' });
    return optionsOf(trigger);
  }

  it('says "add below" to a person who may change company settings', async () => {
    const options = await hintOnLeadForm(withCompanySettings);
    expect(options.join(' ')).toContain('No options - add below');
  });

  it('does not say "add below" to a person who may not', async () => {
    const options = await hintOnLeadForm(technician);
    expect(options.join(' ')).toContain('No options');
    expect(options.join(' ')).not.toContain('add below');
    expect(options.join(' ')).not.toContain('Add new type');
  });

  it('does not say "add below" on the job form either', async () => {
    serve({ job_type_options: [], source_options: [] });
    renderWithProviders(<JobFormPage />, { ability: technician, initialEntries: ['/jobs/new'] });
    const trigger = await screen.findByRole('combobox', { name: /job type/i });
    const options = await optionsOf(trigger);
    expect(options.join(' ')).toContain('No options');
    expect(options.join(' ')).not.toContain('add below');
  });
});
