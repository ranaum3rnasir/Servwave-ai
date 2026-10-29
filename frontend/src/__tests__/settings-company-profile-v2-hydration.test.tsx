/**
 * #1919, sibling half. Form hydration on the ROUTED Company Profile screen.
 *
 * Imports `@/pages/v2/settings/CompanyProfilePage` - what
 * `pages/v2/routes/settings.routes.tsx` mounts at /settings/company. The older
 * `settings-company-profile.test.tsx` imports `@/pages/settings/
 * CompanyProfilePage`, which nothing outside that spec file imports any more,
 * so a gate written there passes against a page nobody opens. Hence a new file
 * rather than an extension of that one.
 *
 * WHAT THE TRIGGER ACTUALLY IS HERE. My Profile's defect is driven by an
 * unattended /api/auth/me revalidation. `useOrganization` has no poll at all -
 * it refetches on window focus - and TanStack Query's default structural
 * sharing hands back the PREVIOUS object whenever the payload is unchanged, so
 * an ordinary refocus never re-runs the hydration effect. The first spec below
 * pins that, because it is the reason this page looked innocent.
 *
 * What does reach it is a refocus that lands on a payload another admin has
 * changed - ANY field, not only the one being edited. That produces a genuinely
 * new object, the effect re-runs, and `reset()` takes the in-flight edit with
 * it. Same silent loss, narrower door.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act, fireEvent, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility } from '@/lib/ability';
import CompanyProfilePage from '@/pages/v2/settings/CompanyProfilePage';
import type { SettingsSaver } from '@/lib/settings/types';

const mockApi = vi.mocked(api);

// The read-only fieldset disables every control without this grant
// (renderWithProviders with no ability -> emptyAbility -> all deny).
const EDIT_ABILITY = buildAbility([{ action: 'update', subject: 'Organization' }]);

// The Save bar lives in the settings shell, not the page. Capture what the page
// registers so the dirty flag - the one SettingsLayout pushes into the settings
// guard store - can be asserted directly.
let registered: SettingsSaver | null = null;

vi.mock('@/pages/v2/settings/settingsBar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/v2/settings/settingsBar')>();
  return {
    ...actual,
    useSettingsBar: () => ({
      registerSaver: (fns: SettingsSaver) => {
        registered = fns;
      },
    }),
  };
});

const ORG_BASE = {
  id: 'o1',
  name: 'Acme HVAC',
  display_name: 'Acme',
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
  email_sending_enabled: true,
  sms_sending_enabled: true,
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
  default_job_duration_min: 120,
  default_walkthrough_duration_min: 60,
  default_schedule_start_time: '08:00',
};

/** A form box by its registered `name`, which survives the value changing. */
const box = (name: string) =>
  (document.querySelector(`input[name="${name}"]`) as HTMLInputElement).value;

/** Drain the microtask/timer queue so a NEGATIVE assertion is not a race. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

/** A FRESH object every call - exactly what an HTTP refetch produces. */
function serve(org: Record<string, unknown>) {
  mockApi.get.mockImplementation(() => Promise.resolve({ data: { ...org } }));
}

beforeEach(() => {
  vi.clearAllMocks();
  registered = null;
  serve(ORG_BASE);
});

function renderPage() {
  return renderWithProviders(<CompanyProfilePage />, { ability: EDIT_ABILITY });
}

describe('v2 Company Profile - a refetch must not discard an edit', () => {
  it('is untouched by a refetch whose payload has not changed', async () => {
    const { queryClient } = renderPage();
    await screen.findByDisplayValue('Acme');

    fireEvent.change(document.querySelector('input[name="display_name"]')!, {
      target: { value: 'AcmeZZ' },
    });

    // Three refocus-driven refetches. Structural sharing returns the previous
    // object each time, so the hydration effect never even runs - this is the
    // baseline, and it is why the reported My Profile symptom does not show up
    // on this page.
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: ['organization'] });
      });
    }
    await settle();
    expect(mockApi.get).toHaveBeenCalledTimes(4);

    expect(box('display_name')).toBe('AcmeZZ');
    expect(registered!.isDirty).toBe(true);
  });

  it('keeps the edit when the refetch brings a payload another admin changed', async () => {
    const { queryClient } = renderPage();
    await screen.findByDisplayValue('Acme');

    fireEvent.change(document.querySelector('input[name="display_name"]')!, {
      target: { value: 'AcmeZZ' },
    });
    await waitFor(() => expect(registered!.isDirty).toBe(true));

    // Somebody else set the website. Nothing to do with the box being typed
    // into, but it makes the object new - which used to be enough.
    serve({ ...ORG_BASE, website: 'https://acme.test' });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['organization'] });
    });
    // Flush every follow-on render, so "the form did not change" is a real
    // observation and not a race with one that had not landed yet. The pristine
    // spec below is the positive control on this same machinery - there the
    // refetched value DOES reach the form.
    await settle();
    expect(mockApi.get).toHaveBeenCalledTimes(2);

    expect(box('display_name')).toBe('AcmeZZ');
    expect(box('website')).toBe('');
    // The flag SettingsLayout publishes into the settings guard store. Losing
    // the text is bad; losing it AND telling the shell there was nothing to
    // lose is the #1917 failure mode reached from a new direction.
    expect(registered!.isDirty).toBe(true);
  });

  it('still refreshes a form nobody has touched', async () => {
    const { queryClient } = renderPage();
    await screen.findByDisplayValue('Acme');

    // Pristine, so hydrating is exactly what the effect is for. Gating on the
    // org id alone would freeze this page against every change made elsewhere.
    serve({ ...ORG_BASE, display_name: 'Acme Doors' });
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['organization'] });
    });

    await waitFor(() => expect(box('display_name')).toBe('Acme Doors'));
    expect(registered!.isDirty).toBe(false);
  });

  it('hydrates from the org on first load', async () => {
    renderPage();
    await screen.findByDisplayValue('Acme');
    expect(box('name')).toBe('Acme HVAC');
    expect(registered!.isDirty).toBe(false);
  });
});
