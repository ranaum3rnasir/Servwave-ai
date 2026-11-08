import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import CompanyProfilePage from '@/pages/settings/CompanyProfilePage';

const mockApi = vi.mocked(api);

// Ability granting update on Organization (Admin-equivalent). The 5 TG14 tests
// below type into inputs that the new read-only fieldset would disable without
// this grant (renderWithProviders with no ability → emptyAbility → all deny).
const EDIT_ABILITY = buildAbility([{ action: 'update', subject: 'Organization' }]);

// Capture the registered saver so tests can invoke it directly (the Save
// Changes button lives in SettingsLayout, not in the page itself).
let capturedSave: (() => Promise<void> | void) | null = null;

vi.mock('@/pages/settings/SettingsLayout', () => ({
  useSettingsBar: () => ({
    registerSaver: (fns: { save: () => Promise<void> | void }) => {
      capturedSave = fns.save;
    },
  }),
}));

const ORG_BASE = {
  id: 'o1',
  name: 'Acme HVAC',
  display_name: '',
  legal_name: '',
  tax_id: '',
  business_type: '',
  industry: [],
  email: '',
  support_email: '',
  billing_email: '',
  phone: '',
  website: '',
  timezone: 'America/Chicago',
  currency: 'USD',
  date_format: 'MM/DD/YYYY',
  country: 'US',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  mailing_same_as_hq: true,
  mailing_address_line1: '',
  mailing_address_line2: '',
  mailing_city: '',
  mailing_state: '',
  mailing_postal_code: '',
  mailing_country: 'US',
  customer_prefix: 'C',
  customer_next_number: 1,
  lead_prefix: 'L',
  lead_next_number: 1,
  estimate_prefix: 'E',
  estimate_next_number: 1,
  job_prefix: 'J',
  job_next_number: 1,
  invoice_prefix: 'I',
  invoice_next_number: 1,
  service_plan_prefix: 'SP',
  service_plan_next_number: 1,
  // Scheduling defaults
  default_job_duration_min: 120,
  default_walkthrough_duration_min: 60,
  default_schedule_start_time: '08:00',
};

beforeEach(() => {
  vi.clearAllMocks();
  capturedSave = null;
  mockApi.get.mockResolvedValue({ data: ORG_BASE });
  mockApi.patch.mockResolvedValue({ data: ORG_BASE });
});

describe('CompanyProfilePage — scheduling defaults (TG14)', () => {
  it('renders the scheduling defaults section with correct labels', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    expect(await screen.findByText('Scheduling Defaults')).toBeInTheDocument();
    expect(screen.getByText('Default job duration (min)')).toBeInTheDocument();
    expect(screen.getByText('Default walkthrough duration (min)')).toBeInTheDocument();
    expect(screen.getByText('Default start time')).toBeInTheDocument();
    expect(screen.getByText(/Used by the scheduler/)).toBeInTheDocument();
  });

  it('hydrates the start time field with the org value, in 12-hour AM/PM', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    // TimeCombobox (a typeable text field) replaced the native <input type="time">,
    // whose clock followed the BROWSER locale and read 24-hour outside the US. The
    // stored contract is still 'HH:MM' - only the displayed text is 12-hour.
    const timeInput = await screen.findByDisplayValue('8:00 AM');
    expect(timeInput).toHaveAttribute('type', 'text');
  });

  it('hydrates duration inputs with org values', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    // default_job_duration_min = 120; wait for hydration then check 60
    await screen.findByDisplayValue('120');
    expect(screen.getByDisplayValue('60')).toBeInTheDocument();
  });

  it('PATCHes only the dirty field when job duration is changed and saved', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });

    const durationInput = await screen.findByDisplayValue('120');
    await user.clear(durationInput);
    await user.type(durationInput, '90');

    // Trigger the registered saver (equivalent to clicking "Save Changes" in SettingsLayout)
    expect(capturedSave).not.toBeNull();
    await capturedSave!();

    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    const [url, payload] = mockApi.patch.mock.calls[0];
    expect(url).toBe('/api/organization');
    expect(payload).toMatchObject({ default_job_duration_min: 90 });
    // dirty-only: untouched fields must NOT appear in the patch body
    expect(payload).not.toHaveProperty('default_schedule_start_time');
    expect(payload).not.toHaveProperty('default_walkthrough_duration_min');
  });

  it('does not call PATCH when nothing has changed', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    await screen.findByText('Scheduling Defaults');

    expect(capturedSave).not.toBeNull();
    await capturedSave!();

    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});

describe('CompanyProfilePage — numbering floor (forward-only, Workiz-style)', () => {
  const ORG_WITH_LEADS = { ...ORG_BASE, lead_next_number: 100 };

  beforeEach(() => {
    mockApi.get.mockResolvedValue({ data: ORG_WITH_LEADS });
    mockApi.patch.mockResolvedValue({ data: ORG_WITH_LEADS });
  });

  it('shows the forward-only floor (minimum) for a document row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyProfilePage />);
    // Numbering fields live in the "Identifiers & Numbering" tab, not the default Profile tab.
    await user.click(await screen.findByRole('tab', { name: /Identifiers/i }));
    expect(await screen.findByText('Minimum 100')).toBeInTheDocument();
  });

  it('blocks a save below the floor with a ValidationError and sends no PATCH', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    await user.click(await screen.findByRole('tab', { name: /Identifiers/i }));

    const leadInput = await screen.findByDisplayValue('100');
    await user.clear(leadInput);
    await user.type(leadInput, '50');

    // The live hint flips to the danger message before any save.
    expect(await screen.findByText('Cannot go below 100')).toBeInTheDocument();

    // The saver rejects (propagates to the settings shell) and never hits the API.
    expect(capturedSave).not.toBeNull();
    await expect(capturedSave!()).rejects.toThrow(/cannot be lower than 100/i);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('allows raising a next number above the floor', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
    await user.click(await screen.findByRole('tab', { name: /Identifiers/i }));

    const leadInput = await screen.findByDisplayValue('100');
    await user.clear(leadInput);
    await user.type(leadInput, '250');

    await capturedSave!();
    expect(mockApi.patch).toHaveBeenCalledTimes(1);
    const [, payload] = mockApi.patch.mock.calls[0];
    expect(payload).toMatchObject({ lead_next_number: 250 });
  });
});

describe('CompanyProfilePage — read-only viewer + dual timezone (#457)', () => {
  it('renders company fields read-only when lacking update Organization', async () => {
    // No ability → emptyAbility → cannot update Organization (e.g. Dispatcher).
    renderWithProviders(<CompanyProfilePage />);

    const nameInput = await screen.findByDisplayValue('Acme HVAC');
    expect(nameInput).toBeDisabled(); // disabled via fieldset ancestor

    expect(
      screen.getByText(/managed by an administrator/i),
    ).toBeInTheDocument();

    // A read-only viewer can never dirty the form, so Save must be a no-op.
    expect(capturedSave).not.toBeNull();
    await capturedSave!();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('renders company fields editable with the update grant', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });

    const nameInput = await screen.findByDisplayValue('Acme HVAC');
    expect(nameInput).not.toBeDisabled();

    expect(screen.queryByText(/managed by an administrator/i)).toBeNull();
  });

  // #457 originally shipped a SIDE-BY-SIDE "your local zone vs the company zone" panel. That
  // framing is now wrong and the local half is gone: there is one company clock, every
  // scheduled time in the product is stored and rendered against it, and showing viewers their
  // own zone here only invited the belief that both were in play.
  it('shows the company time zone and no longer offers the viewer their local zone', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });

    // findAllByText waits for reset(org) hydration so watch('timezone') reflects the company
    // zone (ORG_BASE.timezone). It appears in the picker's trigger and in the clock panel.
    expect((await screen.findAllByText(/America\/Chicago/)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Company time zone')).toBeInTheDocument();
    expect(screen.queryByText('Your local time zone')).toBeNull();
  });

  it('offers the time zone as a picker rather than a free-text box', async () => {
    // A typo like "Eastern" makes Intl throw inside the render path now that every scheduled
    // time resolves against this value, so the field must not accept arbitrary text.
    renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });

    expect(await screen.findByRole('combobox', { name: 'Time Zone' })).toBeInTheDocument();
  });
});
