import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE, NOTES_FIXTURE } from './helpers';
import { buildAbility } from '@/lib/ability';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import LeadDetailPage from '@/pages/v2/leads/LeadDetailPage';

// THE ROUTED LEAD PAGE. `App.tsx` builds its whole route table from `v2Routes()`, so
// `/leads/:id` mounts `pages/v2/leads/LeadDetailPage` and nothing else. This file used to
// import the unrouted `pages/LeadDetailPage`, which meant every assertion below ran green
// against a page no user could open while the one they DO open was free to drift. That page
// is deleted; these specs now hold the surface that ships.

// Org-level comms access (E2): default FALSE — the pre-existing specs exercise
// the native tel: baseline; the call-entry matrix flips it per test.
const commAccess = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));

// Task B4 — the customer phone link routes through the cross-tab dial
// handoff into the /phone tab, not the legacy in-app GlobalDialer popup.
vi.mock('@/lib/communication/phoneTabHandoff', () => ({
  requestCall: vi.fn(),
}));

// Capture the entity prop passed to JobLeadTasksTab to assert UUID correctness
let capturedLeadEntity: { type: string; id: string; label: string } | null = null;
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({
  JobLeadTasksTab: (props: { entity: { type: string; id: string; label: string } }) => {
    capturedLeadEntity = props.entity;
    return null;
  },
}));

// Mock the lead comms tab (slice E4 swapped the customer roll-up out for the
// lead-union timeline) so the Communication tab tests can assert the leadId +
// customerId wiring without pulling in the real query.
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({
  LeadCommunicationsTab: (p: { leadId: string; customerId?: string }) => (
    <div data-testid="lead-comms" data-lead={p.leadId} data-customer={p.customerId} />
  ),
}));

// Action buttons (Edit, Assign, Mark Lost, Create Estimate, Convert to Job …) are
// now gated on CASL ability rather than the auth-store role (see #238). Render
// with a full-access (admin superuser) ability so the action surface appears.
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

// floating-ui (under Radix dropdown) does `new ResizeObserver(...)`; the global
// setup mock returns a plain object and isn't constructable, so install a real
// class stub (same pattern as sms-inbox-job-pills.test.tsx).
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

// The customer phone/email controls assign `window.location.href` for their native
// tel:/mailto: fallback. jsdom's real Location cannot be assigned to, so it is swapped for a
// plain object for this file (same swap as pages/v2/schedule/__tests__/eventEditor.test.tsx).
const REAL_LOCATION = window.location;
Object.defineProperty(window, 'location', {
  configurable: true,
  writable: true,
  value: { ...window.location, href: '' },
});
afterAll(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: REAL_LOCATION });
});

// Mock useParams to return the lead ID
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
  };
});

const mockApi = vi.mocked(api);
const mockRequestCall = vi.mocked(requestCall);

const openLeadActions = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(await screen.findByRole('button', { name: /Lead actions/i }));

beforeEach(() => {
  vi.clearAllMocks();
  capturedLeadEntity = null;
  commAccess.value = false;
  window.location.href = '';

  // GET /api/leads/:id
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) {
      return { data: { notes: NOTES_FIXTURE } };
    }
    if (url.includes('/api/users')) {
      return { data: { users: [{ id: 'u1', first_name: 'Alice', last_name: 'Sales', role: 'SALES', is_active: true, has_login: true, department: null }] } };
    }
    if (url.includes('/api/leads/')) {
      return { data: { lead: LEAD_FIXTURE } };
    }
    if (url.includes('/api/tags')) {
      return { data: { tags: [] } };
    }
    return { data: {} };
  });
});

// RETIRED: "LeadDetailPage tab strip - TabStrip rendered contract".
//
// That block pinned `components/patterns/TabStrip`'s rendered class strings byte-exact
// (`flex items-center gap-[26px] border-b border-border`, a `border-b-[3px]` trigger, a
// `border-t border-border` wrapper) as they appeared on the legacy page. The routed page does
// not render that component at all - it composes `pages/v2/_shared/tabs`, whose strip is a row
// of kit Buttons with native `aria-selected` and a `border-b-2` indicator. Re-pinning those
// literals here would only re-state what `pages/v2/_shared/__tests__/tabs.test.tsx` already
// owns for the shared component, so the pin is dropped rather than rewritten. The tabs
// themselves are still covered below, by role and by label.

// Heading names are matched loosely on purpose. The record-number editor renders its "Edit
// number" pencil INSIDE the heading, and a button's label counts toward the accessible name of
// the element containing it, so the exact string is "L00001 Edit number - John Doe" when the
// signed-in ability carries the renumber grant and "L00001 - John Doe" when it does not.
describe('v2 LeadDetailPage', () => {
  it('renders lead title with customer name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
  });

  it('renders customer company name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Company name renders in both the hero and the contact card.
    await waitFor(() => {
      expect(screen.getAllByText('Doe HVAC').length).toBeGreaterThan(0);
    });
  });

  it('renders all 4 tab triggers', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
    });
    // "Walkthrough" appears in both a tab trigger and a section heading.
    expect(screen.getAllByText('Walkthrough').length).toBeGreaterThan(0);
    // The Attachments tab label now includes a count, e.g. "Attachments (0)".
    expect(screen.getByText(/Attachments \(\d+\)/)).toBeInTheDocument();
    // The Estimates tab label includes a count, e.g. "Estimates (0)".
    expect(screen.getByText(/Estimates \(\d+\)/)).toBeInTheDocument();
  });

  it('shows KPI strip labels', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Estimated Value')).toBeInTheDocument();
    });
    expect(screen.getByText('Days Open')).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
  });

  it('shows service request in Details tab', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('AC not cooling')).toBeInTheDocument();
    });
  });

  it('shows assigned user name', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Test Sales')).toBeInTheDocument();
    });
  });

  it('shows customer phone', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // Phone is rendered through formatPhone().
    await waitFor(() => {
      expect(screen.getByText('(555) 123-4567')).toBeInTheDocument();
    });
  });

  // ── E2: in-app call entry gating for the customer phone link ─────────────

  it('routes into the /phone tab with lead attribution when comms access + create ability are present', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const phoneButton = await screen.findByRole('button', { name: '(555) 123-4567' });
    await user.click(phoneButton);

    expect(mockRequestCall).toHaveBeenCalledWith('5551234567', {
      leadId: 'e0000000-0000-0000-0000-000000000001',
      leadLabel: 'L00001',
      customerId: 'c0000000-0000-0000-0000-000000000001',
      customerName: 'John Doe',
    });
  });

  // The two ungated cases below used to read `closest('a')` for an `href="tel:..."`, because
  // the legacy page rendered two different ELEMENTS - a <button> with comms, an <a> without.
  // The routed page renders one control either way and branches inside its handler, so the
  // fallback is asserted where it now lives: the click sets `window.location.href` to the
  // tel: URL and never reaches `requestCall`. Asserting the destination (not just the absence
  // of the button) keeps this from passing on a control that does nothing at all.
  it('falls back to the native tel: destination without org comms access', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: '(555) 123-4567' }));

    expect(window.location.href).toBe('tel:5551234567');
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('falls back to the native tel: destination without create:Communication even with comms access', async () => {
    commAccess.value = true;
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, {
      ability: buildAbility([{ action: 'read', subject: 'Communication' }]),
    });

    await user.click(await screen.findByRole('button', { name: '(555) 123-4567' }));

    expect(window.location.href).toBe('tel:5551234567');
    expect(mockRequestCall).not.toHaveBeenCalled();
  });

  it('shows action buttons for ADMIN', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    expect(screen.getByText('Assign')).toBeInTheDocument();
    expect(await screen.findByRole('menuitem', { name: 'Mark Lost' })).toBeInTheDocument();
  });

  it('shows estimates empty state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // The Estimates tab trigger is labelled "Estimates (N)".
    const estimatesTab = await screen.findByText(/Estimates \(\d+\)/);
    await user.click(estimatesTab);

    await waitFor(() => {
      expect(screen.getByText('No estimates yet.')).toBeInTheDocument();
    });
  });

  // NOTE: the lead-notes tab (a notes list + "Add a note..." textarea) was removed
  // when LeadDetailPage was restructured to the Overview/Walkthrough/Estimates/
  // Attachments layout. Lead notes are no longer surfaced on this page, so the two
  // prior notes tests were dropped rather than left asserting on absent UI.

  it('renders not found state when lead is null', async () => {
    mockApi.get.mockResolvedValue({ data: { lead: null } });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await waitFor(() => {
      expect(screen.getByText('Lead not found.')).toBeInTheDocument();
    });
  });
});

// #397 gave the Lead page a Communication tab (customer roll-up); slice E4
// swapped its body onto LeadCommunicationsTab — the LEAD union endpoint — so
// lead_id-only rows surface too. Wired with the lead's own id (plus the
// customer id for the attach menu scope), gated on `read Communication` (RBAC
// parity with the Customer/Job pages). The tab is Radix-lazy, so the mock only
// mounts once clicked.
describe('v2 LeadDetailPage - Communication tab (#397 / E4)', () => {
  it('renders the Communication tab and mounts the lead comms timeline with the lead id (+ customer scope)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const commsTab = await screen.findByRole('tab', { name: /^Communication$/ });
    await user.click(commsTab);

    await waitFor(() => {
      expect(screen.getByTestId('lead-comms')).toBeInTheDocument();
    });
    // Wired to the LEAD id (the union endpoint's scope) — not customer-only anymore.
    expect(screen.getByTestId('lead-comms')).toHaveAttribute(
      'data-lead',
      'e0000000-0000-0000-0000-000000000001'
    );
    // The customer id rides along as the open-jobs scope for the attach menu.
    expect(screen.getByTestId('lead-comms')).toHaveAttribute(
      'data-customer',
      'c0000000-0000-0000-0000-000000000001'
    );
  });

  it('hides the Communication tab when the ability lacks read Communication', async () => {
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('tab', { name: /^Communication$/ })).toBeNull();
  });
});

describe('v2 LeadDetailPage - Convert to Job (bug #12)', () => {
  const APPROVED_ESTIMATE = {
    id: 'es000000-0000-0000-0000-000000000001',
    estimate_number: 'E00001',
    status: 'WON',
    total_amount: '1500.00',
    created_at: '2026-02-01T00:00:00.000Z',
  };

  function mockLeadWithApprovedEstimate() {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) {
        return {
          data: { lead: { ...LEAD_FIXTURE, status: 'WON', estimates: [APPROVED_ESTIMATE] } },
        };
      }
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  }

  it('Create Job opens the convert dialog; confirming POSTs /api/jobs with the approved estimate_id', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    mockLeadWithApprovedEstimate();
    mockApi.post.mockResolvedValue({ data: { job: { id: 'j0000000-0000-0000-0000-000000000001' } } });

    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    // "Convert to job" menu item (gated on CASL `create Job`) opens the convert dialog.
    await openLeadActions(user);
    await user.click(screen.getByRole('menuitem', { name: /Convert to job/i }));

    // CreateJobFromLeadDialog auto-selects the lone WON estimate; its "Create job"
    // confirm fires onConvert → createJobMutation → POST /api/jobs { estimate_id }. Scope
    // to the dialog so we hit the confirm, not the masthead button (both match /Create job/i).
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Create job/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/jobs', {
        estimate_id: APPROVED_ESTIMATE.id,
      }),
    );
  });
});

describe('v2 LeadDetailPage - Assign menu item (#576)', () => {
  it('Assign menu item opens the assign popover (menu closes, panel opens)', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await openLeadActions(user);
    await user.click(screen.getByRole('menuitem', { name: /Assign/i }));
    // Panel open: search input + roster row visible
    expect(await screen.findByPlaceholderText(/search team members/i)).toBeInTheDocument();
    expect(await screen.findByText('Alice Sales')).toBeInTheDocument();
    // Menu closed: no menuitems remain
    expect(screen.queryByRole('menuitem')).toBeNull();
  });
});

describe('v2 LeadDetailPage - JobLeadTasksTab receives entity UUID', () => {
  it('passes the lead UUID (route param id) not lead_number as entity.id', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LeadDetailPage />);

    // Wait for the page to load, then click the Tasks tab to mount JobLeadTasksTab
    const tasksTab = await screen.findByRole('tab', { name: /^Tasks$/ });
    await user.click(tasksTab);

    await waitFor(() => {
      expect(capturedLeadEntity).not.toBeNull();
    });
    // useParams returns id: 'e0000000-0000-0000-0000-000000000001'
    expect(capturedLeadEntity!.id).toBe('e0000000-0000-0000-0000-000000000001');
    expect(capturedLeadEntity!.type).toBe('LEAD');
  });
});

// #238 — action buttons gate on CASL ability, NOT the auth-store role. The auth
// store is mocked to ADMIN globally (setup.ts); these tests pass a narrower
// ability and prove the buttons follow it, independent of that role.
describe('v2 LeadDetailPage - action buttons gate on ability not role (#238)', () => {
  // A SALES-shaped ability: can edit/mark-lost a lead and create estimates, but
  // CANNOT assign (no `assign Lead` grant for Sales).
  const salesAbility = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'update', subject: 'Lead' },
    { action: 'mark_lost', subject: 'Lead' },
    { action: 'create', subject: 'Estimate' },
  ]);

  it('shows Edit (update Lead) but hides Assign when ability lacks assign Lead', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: salesAbility });

    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // Create Estimate is granted; Assign is not. #2048 - nothing is convertible on this
    // fixture (no estimates), so the header ALSO renders a primary "Create Estimate" button
    // alongside the kebab's own item - scope to the kebab item, which is what this test covers.
    expect(screen.getByRole('menuitem', { name: 'Create Estimate' })).toBeInTheDocument();
    expect(screen.queryByText('Assign')).toBeNull();
  });

  it('hides all editor actions for a read-only ability (despite ADMIN auth role)', async () => {
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    // Page still renders the lead, but no Edit/Assign/Create Estimate buttons.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Assign')).toBeNull();
    expect(screen.queryByText('Create Estimate')).toBeNull();
  });
});

// #238 follow-up - the "Mark Lost" (mark_lost Lead) action split off the old
// `canEdit`/`update Lead` gate onto its own capability. LEAD_FIXTURE.status is NEW
// (not terminal), so the button is status-eligible - visibility therefore turns
// purely on the ability. These lock the split gate from both sides; previously
// only the granted side was implied.
//
// Walkthrough-as-entity redesign, PR-C2: this block used to also cover "Mark
// Contacted" (contact Lead) - D6 removed that menu item and its ContactLeadDialog
// entirely (contacted_at is now inferred from outbound activity, never set by
// hand), so there is no longer a button here to gate.
describe('v2 LeadDetailPage - mark_lost gates on its own capability (#238)', () => {
  it('shows Mark Lost when the ability grants mark_lost Lead', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const ability = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'mark_lost', subject: 'Lead' },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability });

    await openLeadActions(user);
    expect(screen.getByText('Mark Lost')).toBeInTheDocument();
  });

  it('hides Mark Lost when the ability lacks mark_lost Lead', async () => {
    // Holds update Lead (so the page is clearly in "editor" mode and Edit shows),
    // but NOT mark_lost - proving the button no longer rides canEdit.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const ability = buildAbility([
      { action: 'read', subject: 'Lead' },
      { action: 'update', subject: 'Lead' },
    ]);
    renderWithProviders(<LeadDetailPage />, { ability });

    // Edit (update Lead) renders, confirming the action surface is mounted...
    await openLeadActions(user);
    expect(screen.getByText('Edit')).toBeInTheDocument();
    // ...but the capability-split action is absent.
    expect(screen.queryByText('Mark Lost')).toBeNull();
  });
});

// Phase B (strict technician) — the Walkthrough recording + completion controls
// (Notes editor, Save Notes, Complete Walkthrough) gate on `perform_walkthrough
// Lead`, NOT `update Lead`. A strict TECHNICIAN was re-scoped to hold
// `perform_walkthrough` (OWN_WALKTHROUGH) but NOT `update Lead`; the backend routes
// POST /:id/walkthrough + /walkthrough/complete already enforce `perform_walkthrough`.
// Before this fix the UI rode `canEdit` (`update Lead`), so a strict tech could not
// record/complete their own walkthrough from the UI even though the API allowed it.
describe('v2 LeadDetailPage - walkthrough recording gates on perform_walkthrough not update (Phase B)', () => {
  // Drive WalkthroughTabContent into its SCHEDULED branch so the Notes editor +
  // Complete Walkthrough button render. A scheduled lead with no completed_at.
  function mockScheduledWalkthroughLead() {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/leads/')) {
        return {
          data: {
            lead: {
              ...LEAD_FIXTURE,
              status: 'CONTACTED',
              walkthrough_scheduled_at: '2026-03-01T15:00:00.000Z',
              walkthrough_duration_minutes: 60,
              walkthrough_completed_at: null,
              walkthrough_notes: null,
              walkthrough_performers: [
                { user: { id: '00000000-0000-0000-0000-000000000004', first_name: 'Test', last_name: 'Tech' } },
              ],
            },
          },
        };
      }
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  }

  // Strict technician: can read the lead + perform (record/complete) its
  // walkthrough, but CANNOT update the lead or schedule a walkthrough.
  const technicianAbility = buildAbility([
    { action: 'read', subject: 'Lead' },
    { action: 'perform_walkthrough', subject: 'Lead' },
  ]);

  it('lets a technician (perform_walkthrough, no update) open the Walkthrough tab and use record + complete controls', async () => {
    const user = userEvent.setup();
    mockScheduledWalkthroughLead();
    renderWithProviders(<LeadDetailPage />, { ability: technicianAbility });

    // The page renders for a read-only-ish lead ability...
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
    // ...and the Walkthrough tab is reachable (not gated on update Lead).
    const walkthroughTab = screen.getByRole('tab', { name: /Walkthrough/ });
    await user.click(walkthroughTab);

    // The Complete step is shown (perform_walkthrough), even though the tech lacks
    // `update Lead`. Named "Complete" since scheduling-notifications slice 09.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Complete' })).toBeInTheDocument();
    });

    // The Notes editor is enabled, and typing a note reveals the Save Notes button.
    const notes = screen.getByPlaceholderText('Walkthrough notes...');
    expect(notes).not.toBeDisabled();
    await user.type(notes, 'Unit is on the roof; access via south stairwell.');
    expect(await screen.findByRole('button', { name: /Save Notes/ })).toBeInTheDocument();
  });

  it('hides record + complete controls for a user with neither update nor perform_walkthrough', async () => {
    const user = userEvent.setup();
    mockScheduledWalkthroughLead();
    // read-only: can see the lead/tab, but cannot record or complete.
    const readOnly = buildAbility([{ action: 'read', subject: 'Lead' }]);
    renderWithProviders(<LeadDetailPage />, { ability: readOnly });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
    const walkthroughTab = screen.getByRole('tab', { name: /Walkthrough/ });
    await user.click(walkthroughTab);

    // The Notes editor renders read-only and the Complete button is absent.
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Walkthrough notes...')).toBeDisabled();
    });
    expect(screen.queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save Notes/ })).toBeNull();
  });
});

// ─── ?tab=walkthrough deep link (Leads-list schedule action, #445) ───────────

// Probe that reports the current location so the param-strip can be asserted.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname + location.search}</div>;
}

describe('v2 LeadDetailPage - ?tab=walkthrough deep link', () => {
  it('activates the Walkthrough tab and strips the param (replace)', async () => {
    renderWithProviders(
      <>
        <LeadDetailPage />
        <LocationProbe />
      </>,
      {
        ability: adminAbility,
        initialEntries: ['/leads/e0000000-0000-0000-0000-000000000001?tab=walkthrough'],
      }
    );

    // Walkthrough tab becomes the active one (not the default Overview).
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Walkthrough/ })).toHaveAttribute(
        'aria-selected',
        'true'
      );
    });
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // The param is stripped (replace: true) so refresh/back won't re-trigger.
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).not.toContain('tab=walkthrough');
    });
  });

  it('ignores a non-whitelisted ?tab= value', async () => {
    renderWithProviders(<LeadDetailPage />, {
      ability: adminAbility,
      initialEntries: ['/leads/e0000000-0000-0000-0000-000000000001?tab=bogus'],
    });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
    });
    // Overview stays active; the bogus value selects nothing.
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Walkthrough/ })).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });
});

// Walkthrough lead statuses: the status menu on the routed page lists every lead status in
// pipeline order (both walkthrough statuses between Contacted and Estimate Sent). The org
// rename/hide overrides are gone, so there is nothing to filter or relabel.
describe('v2 LeadDetailPage - status menu', () => {
  it('lists all eight lead statuses in pipeline order under their labels', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await user.click(await screen.findByRole('button', { name: 'Lead status: New' }));

    expect(await screen.findByRole('menuitem', { name: /Contacted/ })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((el) => el.textContent?.trim())).toEqual([
      'New',
      'Contacted',
      'Walkthrough Scheduled',
      'Walkthrough Completed',
      'Estimate Sent',
      'Won',
      'Lost',
      'Cancelled',
    ]);
  });
});

// Editable record IDs (2026-08-19 plan) - RecordNumberEditor wired into the header's
// lead-number render, gated on ability.can('renumber', 'Lead').
describe('LeadDetailPage - record number editor gating', () => {
  it('shows the edit affordance for a user with the renumber grant', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });

  it('hides the edit affordance for a user without the renumber grant', async () => {
    renderWithProviders(<LeadDetailPage />);

    await screen.findAllByText('L00001');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });
});

// Editable record IDs (2026-08-19 plan) - RecordNumberEditor wired into the header's
// lead-number render, gated on ability.can('renumber', 'Lead').
describe('LeadDetailPage - record number editor gating', () => {
  it('shows the edit affordance for a user with the renumber grant', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    expect(await screen.findByRole('button', { name: /edit id/i })).toBeInTheDocument();
  });

  it('hides the edit affordance for a user without the renumber grant', async () => {
    renderWithProviders(<LeadDetailPage />);

    await screen.findAllByText('L00001');
    expect(screen.queryByRole('button', { name: /edit id/i })).toBeNull();
  });
});

// ─── The lead's anchored Service Location (entity-redesign §3/§10, slice 01) ───
//
// The discriminating fixture is a customer holding THREE locations whose lead is anchored to a
// NON-PRIMARY one. A single-location customer, or a lead anchored to the primary, renders the
// same thing under the old roster panel as under the new single-anchor panel, so it would prove
// nothing.
const HEAD_OFFICE = {
  id: 'l0000000-0000-0000-0000-0000000000a1',
  address_line1: '1 Head Office Plaza',
  address_line2: 'Suite 900',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  is_primary: true,
};
const WAREHOUSE = {
  id: 'l0000000-0000-0000-0000-0000000000a2',
  address_line1: '456 Warehouse Way',
  address_line2: 'Bay 4',
  city: 'Round Rock',
  state: 'TX',
  zip: '78664',
  is_primary: false,
};
const ANNEX = {
  id: 'l0000000-0000-0000-0000-0000000000a3',
  address_line1: '789 Annex Rd',
  address_line2: null,
  city: 'Pflugerville',
  state: 'TX',
  zip: '78660',
  is_primary: false,
};

const MULTI_LOCATION_LEAD = {
  ...LEAD_FIXTURE,
  service_location_id: WAREHOUSE.id,
  service_location: WAREHOUSE,
  customer: {
    ...LEAD_FIXTURE.customer,
    service_locations: [HEAD_OFFICE, WAREHOUSE, ANNEX],
  },
};

describe("LeadDetailPage - the lead's anchored service location", () => {
  const serveLead = (lead: unknown) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/leads/')) return { data: { lead } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  };

  // Anchored on the panel's own testid, not on `heading.closest('div')`. The heading now shares
  // a header row with the change affordance (slice 03), so the nearest ancestor div of the
  // heading is that row, not the panel — and a helper that walks the DOM upwards is hostage to
  // any wrapper anyone adds. The testid is the stable handle the panel publishes.
  const locationPanel = () => screen.findByTestId('lead-service-location');

  it('renders exactly one address, and it is the anchored one - not the primary', async () => {
    serveLead(MULTI_LOCATION_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('456 Warehouse Way, Bay 4')).toBeInTheDocument();
    expect(within(panel).getByText('Round Rock, TX 78664')).toBeInTheDocument();
    expect(within(panel).queryByText(/Head Office Plaza/)).toBeNull();
    expect(within(panel).queryByText(/Annex Rd/)).toBeNull();
  });

  it('heads the panel in the singular', async () => {
    serveLead(MULTI_LOCATION_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await locationPanel();
    expect(screen.queryByText('Service Locations')).toBeNull();
  });

  it('shows no Primary badge on the lead location panel', async () => {
    serveLead(MULTI_LOCATION_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).queryByText('Primary')).toBeNull();
  });
});

// ─── Legacy leads with no anchor (entity-redesign §3/§10, slice 02) ───
//
// Slice 01 gated the whole location panel on the lead's anchor, which cost pre-anchor leads the
// only record of where the work was: they render no panel at all. The panel now renders in all
// three states, and the two unanchored ones say so — an office manager must be able to tell an
// anchored record from an unanchored one at a glance.
//
// The deprecated inline `service_address_*` columns are read here for LEGACY DISPLAY ONLY. They
// remain scheduled for removal by their own phase of the entity redesign; nothing below writes
// them or extends their life.
const LEGACY_LOOSE_ADDRESS_LEAD = {
  ...MULTI_LOCATION_LEAD,
  service_location_id: null,
  service_location: null,
  service_address_line1: '900 Legacy Ln',
  service_address_line2: 'Unit 3',
  service_city: 'Dallas',
  service_state: 'TX',
  service_zip: '75201',
};

// A legacy lead whose loose address is PARTIAL. All five deprecated `service_*` columns are
// independently nullable in the schema, so line1-with-nothing-else is a real stored shape — and
// the anchored path's non-null city/state/zip never exercises it.
const PARTIAL_LOOSE_ADDRESS_LEAD = {
  ...MULTI_LOCATION_LEAD,
  service_location_id: null,
  service_location: null,
  service_address_line1: '900 Legacy Ln',
  service_address_line2: null,
  service_city: null,
  service_state: null,
  service_zip: null,
};

const NO_ADDRESS_AT_ALL_LEAD = {
  ...MULTI_LOCATION_LEAD,
  service_location_id: null,
  service_location: null,
  service_address_line1: null,
  service_address_line2: null,
  service_city: null,
  service_state: null,
  service_zip: null,
};

describe('LeadDetailPage - a lead with no anchored service location', () => {
  const serveLead = (lead: unknown) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/leads/')) return { data: { lead } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  };

  const locationPanel = () => screen.findByTestId('lead-service-location');

  it('renders the legacy loose address when the lead has no anchor', async () => {
    serveLead(LEGACY_LOOSE_ADDRESS_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('900 Legacy Ln, Unit 3')).toBeInTheDocument();
    expect(within(panel).getByText('Dallas, TX 75201')).toBeInTheDocument();
    // Still not the customer's roster: an unanchored lead does not fall back to the head office.
    expect(within(panel).queryByText(/Head Office Plaza/)).toBeNull();
    expect(within(panel).queryByText(/Warehouse Way/)).toBeNull();
  });

  // A legacy lead's address is simply its address. Whether it is a joined ServiceLocation row
  // or the deprecated inline columns is a migration's business, and the panel used to publish
  // that distinction as a warning - which told an office manager a storage detail in the voice
  // of a defect, on a record where nothing was wrong.
  it('states a legacy address without qualifying it', async () => {
    serveLead(LEGACY_LOOSE_ADDRESS_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('900 Legacy Ln, Unit 3')).toBeInTheDocument();
    expect(within(panel).queryByText(/not linked/i)).toBeNull();
    expect(within(panel).queryByText(/stored on the lead/i)).toBeNull();
    expect(within(panel).queryByText(/use the pencil/i)).toBeNull();
  });

  it('still renders the panel, showing the gap, when there is no address at all', async () => {
    serveLead(NO_ADDRESS_AT_ALL_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText(/no service location/i)).toBeInTheDocument();
  });

  it('renders no stray separator line when the legacy address has a line1 and nothing else', async () => {
    serveLead(PARTIAL_LOOSE_ADDRESS_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('900 Legacy Ln')).toBeInTheDocument();
    // The city/state/zip line must be absent entirely, not rendered as a bare ", ".
    const orphanSeparators = within(panel).queryAllByText(
      (_content, element) => /^[\s,]+$/.test(element?.textContent ?? 'x'),
    );
    expect(orphanSeparators).toHaveLength(0);
  });



  // ── The record that forced this wording (Ran, staging, 2026-08-28) ──
  //
  // A legacy lead whose loose address is WORD-FOR-WORD one of the customer's saved addresses.
  // This is the COMMON legacy shape, not a curiosity: the customer kept the site, so the address
  // exists on the roster; the lead simply never pointed at the record. The old mark read "Not
  // linked to a service location" directly beneath an address, under a heading reading "Service
  // Location" — the same three words naming the heading, the thing shown, and the thing denied.
  // A reader with the pencil open then saw that identical address listed as a choice and
  // reasonably concluded the page was contradicting itself.
  //
  // The mark is about the LINK. It must never deny that the customer has the address saved,
  // because on this fixture that denial is simply false.
  const LOOSE_ADDRESS_ALSO_ON_THE_ROSTER = {
    ...MULTI_LOCATION_LEAD,
    service_location_id: null,
    service_location: null,
    service_address_line1: HEAD_OFFICE.address_line1,
    service_address_line2: HEAD_OFFICE.address_line2,
    service_city: HEAD_OFFICE.city,
    service_state: HEAD_OFFICE.state,
    service_zip: HEAD_OFFICE.zip,
  };

  // The record that drove this simplification: a legacy lead whose loose address is word-for-word
  // one of the customer's saved addresses. It is the COMMON legacy shape - the customer kept the
  // site - and the panel is a straight statement of where the work is, on both shapes alike.
  it('reads identically whether the address is joined or inline', async () => {
    serveLead(LOOSE_ADDRESS_ALSO_ON_THE_ROSTER);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('1 Head Office Plaza, Suite 900')).toBeInTheDocument();
    expect(within(panel).getByText('Austin, TX 78701')).toBeInTheDocument();
    expect(within(panel).queryByText(/not linked/i)).toBeNull();
  });

  // The card offers no location control at all now: the lead's own Edit form owns that, and a
  // second, weaker path to the same change is what produced the contradiction in the first place.
  it('offers no location control on the card, for an editor or anyone else', async () => {
    serveLead(LOOSE_ADDRESS_ALSO_ON_THE_ROSTER);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    await locationPanel();
    expect(screen.queryByRole('button', { name: /edit service location/i })).toBeNull();
  });



  // MULTI_LOCATION_LEAD deliberately carries BOTH shapes at once: it spreads LEAD_FIXTURE, whose
  // deprecated `service_address_*` columns are populated ('123 Main St', Austin TX 78701), and it
  // overrides the anchor to WAREHOUSE. That both-populated shape is the only one that can prove
  // precedence, so the `queryByText('123 Main St')` assertion below is what pins the rule that the
  // anchor wins (`looseAddress` is guarded on `!anchoredLocation` in LeadDetailPage). Keep the
  // deprecated columns populated on this fixture until they are deleted from the schema.
  it('renders an anchored lead the same plain way', async () => {
    serveLead(MULTI_LOCATION_LEAD);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await locationPanel();
    expect(within(panel).getByText('456 Warehouse Way, Bay 4')).toBeInTheDocument();
    // The anchor wins outright: the populated deprecated address must not render alongside it.
    expect(within(panel).queryByText('123 Main St')).toBeNull();
    expect(within(panel).queryByText('Austin, TX 78701')).toBeNull();
    expect(within(panel).queryByText(/not linked/i)).toBeNull();
    expect(within(panel).queryByText(/no service location/i)).toBeNull();
  });
});


// ─── A lead with estimates keeps its location readable (slice 04, reduced) ───
//
// The freeze itself is unchanged and still lives in the lead update path (PATCH /api/leads/:id
// returns 400 'Location locked — lead has estimates'), enforced now through the lead's Edit form,
// which stops sending location fields once an estimate exists. What the DETAIL PAGE owes a frozen
// lead is no longer an explanation of a withheld pencil — there is no pencil on this card for
// anyone — it is simply the address, still readable.
const ESTIMATE_ON_LEAD = {
  id: 'e0000000-0000-0000-0000-0000000000e1',
  estimate_number: 'EST-1001',
  status: 'SENT',
  total_amount: '2400.00',
  created_at: '2026-08-01T12:00:00.000Z',
};

describe('LeadDetailPage - a lead with estimates keeps its location readable', () => {
  const serveLead = (lead: unknown) => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
      if (url.includes('/api/users')) return { data: { users: [] } };
      if (url.includes('/api/leads/')) return { data: { lead } };
      if (url.includes('/api/tags')) return { data: { tags: [] } };
      return { data: {} };
    });
  };

  it('keeps the anchored address fully readable while the location is frozen', async () => {
    serveLead({ ...MULTI_LOCATION_LEAD, estimates: [ESTIMATE_ON_LEAD] });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await screen.findByTestId('lead-service-location');
    expect(within(panel).getByText('456 Warehouse Way, Bay 4')).toBeInTheDocument();
    expect(within(panel).getByText('Round Rock, TX 78664')).toBeInTheDocument();
  });

  // The freeze must not be RE-EXPLAINED on the card. That notice existed to account for a
  // missing pencil; with the pencil gone for every lead, it explains the absence of something
  // no one was offered, which is how a settled record starts reading as a broken one.
  it('does not narrate the freeze on the location card', async () => {
    serveLead({ ...MULTI_LOCATION_LEAD, estimates: [ESTIMATE_ON_LEAD] });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await screen.findByTestId('lead-service-location');
    expect(within(panel).queryByText(/location settled/i)).toBeNull();
    expect(within(panel).queryByText(/can no longer be set/i)).toBeNull();
  });

  it('keeps a legacy unanchored lead with an estimate readable too', async () => {
    serveLead({ ...LEGACY_LOOSE_ADDRESS_LEAD, estimates: [ESTIMATE_ON_LEAD] });
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    const panel = await screen.findByTestId('lead-service-location');
    expect(within(panel).getByText('900 Legacy Ln, Unit 3')).toBeInTheDocument();
  });
});
