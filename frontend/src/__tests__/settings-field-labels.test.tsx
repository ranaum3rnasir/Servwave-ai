/**
 * Mobile slice 24 (rubric KB-10, user story 29): every settings field has a
 * programmatic label.
 *
 * The settings `Field` row drew its label above the control but never bound
 * the two (0 of 45 call sites passed `htmlFor`), so a screen reader announced
 * an unnamed edit box and tapping the label did nothing. These specs mount the
 * four routed v2 pages that use `Field` and require, for every label the page
 * draws, that the label is bound to a control (`HTMLLabelElement.control`),
 * and that the named controls answer a role query by their label text.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import { Field } from '@/pages/v2/settings/components/field';
import { Input } from '@/ui-kit/components/ui/input';
import CompanyProfilePage from '@/pages/v2/settings/CompanyProfilePage';
import MyProfilePage from '@/pages/v2/settings/MyProfilePage';
import LocationsPage from '@/pages/v2/settings/LocationsPage';
import InventorySettingsPage from '@/pages/v2/settings/InventorySettingsPage';
import { useUpdateMe } from '@/lib/api/users';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/pages/v2/settings/settingsBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/v2/settings/settingsBar')>();
  return { ...actual, useSettingsBar: () => ({ registerSaver: () => {} }) };
});

vi.mock('@/lib/api/users', () => ({
  useUpdateMe: vi.fn(),
}));

vi.mock('@/components/timeclock/MyTimeLog', () => ({
  default: () => null,
  MyTimeLog: () => null,
}));

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useLocations: () => ({
      data: [{ id: 'loc-1', name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' }],
      isLoading: false,
      isError: false,
    }),
  };
});

const mockApi = vi.mocked(api);

const ORG = {
  id: 'o1',
  name: 'Example Co',
  display_name: 'Example',
  legal_name: '',
  tax_id: '',
  business_type: '',
  industry: [],
  email: '',
  support_email: '',
  billing_email: '',
  phone: '',
  phone_ext: '',
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
  // Off, so the mailing-address block (six more Field rows) renders too.
  mailing_same_as_hq: false,
  mailing_address_line1: '',
  mailing_address_line2: '',
  mailing_city: '',
  mailing_state: '',
  mailing_postal_code: '',
  mailing_country: 'US',
  email_sending_enabled: true,
  sms_sending_enabled: true,
  default_job_duration_min: 120,
  default_walkthrough_duration_min: 60,
  default_schedule_start_time: '08:00',
  default_inventory_location_id: null,
  block_negative_stock: false,
};

const ORG_EDIT = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'update', subject: 'Organization' },
]);

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/locations') return Promise.resolve({ data: [] });
    return Promise.resolve({ data: { ...ORG } });
  });
  vi.mocked(useUpdateMe).mockReturnValue({ mutateAsync: vi.fn() } as unknown as ReturnType<typeof useUpdateMe>);
});

/** The text a label shows, without the decorative required star. */
function labelText(label: HTMLLabelElement): string {
  const clone = label.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (clone.textContent ?? '').trim();
}

/** Every label on the page that is not bound to a control, by its text. */
function unboundLabels(): string[] {
  return Array.from(document.querySelectorAll('label'))
    .filter((l) => (l as HTMLLabelElement).control === null)
    .map((l) => labelText(l as HTMLLabelElement));
}

describe('settings Field binds its label to its control', () => {
  it('names a single control by the label, with no id from the caller', () => {
    renderWithProviders(
      <Field label="Company Name" required>
        <Input />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Company Name' })).toBeInTheDocument();
  });

  it('keeps an id the control already has', () => {
    renderWithProviders(
      <Field label="Website">
        <Input id="org-website" />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Website' })).toHaveAttribute('id', 'org-website');
  });

  it('two Fields on one page get distinct ids', () => {
    renderWithProviders(
      <>
        <Field label="Street"><Input /></Field>
        <Field label="Street"><Input /></Field>
      </>,
    );
    const [a, b] = screen.getAllByRole('textbox', { name: 'Street' });
    expect(a.id).not.toBe('');
    expect(a.id).not.toBe(b.id);
  });
});

describe('every settings field has a programmatic label', () => {
  it('Company Profile: all 29 Field labels are bound', async () => {
    renderWithProviders(<CompanyProfilePage />, { ability: ORG_EDIT });
    await screen.findByDisplayValue('Example');

    expect(unboundLabels()).toEqual([]);
    for (const name of [
      'Company Name',
      'Display / DBA Name',
      'EIN / Tax ID',
      'Industry / Trades (comma-separated)',
      'Primary Phone',
      'Primary Email',
      'Website',
      'Time Zone',
      'Default job duration (min)',
      'Street',
      'ZIP',
    ]) {
      expect(screen.getAllByLabelText(name, { selector: 'input', exact: false }).length).toBeGreaterThan(0);
    }
    // The start-time picker (a TimeField) is bound too: its label is in neither list above.
    const startLabel = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Default start time');
    expect(startLabel?.control?.tagName).toBe('INPUT');
  });

  it('My Profile: every Field label is bound', async () => {
    // One store object for the whole render: a fresh user per selector call reads as an endless
    // stream of profile refetches and the page re-hydrates forever.
    const state = {
      user: {
        id: 'u1', email: 'tech@test.com', first_name: 'Jane', last_name: 'Tester',
        role: 'TECHNICIAN', organization_id: 'o1', phone: '+15551112222', phone_ext: '', has_login: true,
      },
      applyUserPatch: vi.fn(),
    };
    vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
      selector(state)) as typeof useAuthStore);
    renderWithProviders(<MyProfilePage />);
    expect(unboundLabels()).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'First name' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Phone' })).toBeInTheDocument();
  });

  it('Locations: the branch editor labels every field', async () => {
    renderWithProviders(<LocationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new location/i }));

    expect(unboundLabels()).toEqual([]);
    for (const name of ['Branch Name', 'Street', 'City', 'State', 'Time Zone', 'Phone']) {
      expect(screen.getByRole('textbox', { name })).toBeInTheDocument();
    }
  });

  it('Inventory: the default-location picker is labelled', async () => {
    renderWithProviders(<InventorySettingsPage />, { ability: ORG_EDIT });
    await screen.findByText('Default inventory location');
    expect(unboundLabels()).toEqual([]);
  });
});
