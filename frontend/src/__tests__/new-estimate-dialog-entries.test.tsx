/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.26 - the new-estimate dialog offers only the ways out the person may take.
 *
 * "Add new client" (the standalone New Customer) shows only with Create customers + View customers; "Create new lead"
 * for the picked customer only with Create leads; "Create estimate without a lead" only with Standalone estimates. There
 * are two live copies of the dialog (the one behind Create New and the Estimates list, the one behind the dashboard's
 * "New" menu), and each is asserted directly and through every opener. Each person is a custom role described by its
 * switches or by a built-in role's preset values, never by a role name; switch keys and presets are read from the
 * backend catalog by the label a person sees, so a renamed switch fails here instead of silently testing nothing.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { NewEstimateDialog as LegacyNewEstimateDialog } from '@/components/estimates/NewEstimateDialog';
import { NewMenu } from '@/pages/v2/dashboard/components/newMenu';
import { NewEstimateDialog as V2NewEstimateDialog } from '@/pages/v2/estimates/components/newEstimateDialog';
import EstimatesPage from '@/pages/v2/estimates/EstimatesPage';
import { SidebarCreateMenu } from '@/pages/v2/SidebarCreateMenu';
import { AppShell } from '@/ui-kit/components/layout/appShell';

import { renderWithProviders, seedMySwitches } from './helpers';
import {
  abilityWithSwitches, catalogToggle, presetSwitchLabels, type PresetRole,
} from './support/backendSwitchCatalog';

const mockApi = vi.mocked(api);

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const CUSTOMER = {
  id: CUSTOMER_ID, first_name: 'Jane', last_name: 'Doe', company_name: null, phone: '5551234567', email: null,
};

const ADD_NEW_CLIENT = { name: /add new client/i };
const CREATE_LEAD = { name: /create new lead/i };
const NO_LEAD = { name: /create estimate without a lead/i };

/** A person holding exactly these switches (by the label a person sees): their compiled rules and their own answer. */
function personWith(labels: string[]) {
  const values = Object.fromEntries(labels.map((label) => [catalogToggle(label).key, true]));
  return { ability: abilityWithSwitches(...labels), values };
}

function serve(values: Record<string, boolean>) {
  seedMySwitches(values);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/permission-switches/me') return { data: { admin_box: false, values, rules: [] } };
    if (url === `/api/customers/picker/${CUSTOMER_ID}`) return { data: { customer: CUSTOMER } };
    if (url === '/api/customers/picker') return { data: { customers: [CUSTOMER] } };
    if (url === '/api/leads') return { data: { leads: [] } };
    if (url === '/api/estimates') return { data: { estimates: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 1 }, stats: {}, users: [] } };
    return { data: {} };
  });
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

const DIALOGS: Array<[string, ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void; preSelectedCustomerId?: string }>]> = [
  ['the Estimates list and Create New dialog', V2NewEstimateDialog],
  ['the dashboard New menu dialog', LegacyNewEstimateDialog],
];

describe.each(DIALOGS)('%s', (_name, Dialog) => {
  async function openFor(labels: string[]) {
    const person = personWith(labels);
    serve(person.values);
    renderWithProviders(<Dialog open onOpenChange={() => {}} preSelectedCustomerId={CUSTOMER_ID} />, { ability: person.ability });
    await screen.findByText('Jane Doe');
    await screen.findByText('No active leads');
  }

  describe('Add new client', () => {
    it.each([
      ['Create customers and View customers both on', ['Create customers', 'View customers'], true],
      ['Create customers off', ['View customers'], false],
      ['View customers off', ['Create customers'], false],
    ])('%s: shown is %s', async (_case, labels, shown) => {
      await openFor([...labels as string[], 'Create leads']);

      expect(screen.queryByRole('button', ADD_NEW_CLIENT) !== null).toBe(shown);
    });
  });

  describe('Create new lead', () => {
    it('shows with Create leads on', async () => {
      await openFor(['Create leads']);

      expect(screen.getByRole('button', CREATE_LEAD)).toBeInTheDocument();
    });

    it('is hidden with Create leads off', async () => {
      await openFor(['Standalone estimates']);

      expect(screen.queryByRole('button', CREATE_LEAD)).not.toBeInTheDocument();
    });
  });

  describe('Create estimate without a lead', () => {
    it('shows with Standalone estimates on', async () => {
      await openFor(['Standalone estimates']);

      expect(screen.getByRole('button', NO_LEAD)).toBeInTheDocument();
    });

    it('is hidden with Standalone estimates off', async () => {
      await openFor(['Create leads']);

      expect(screen.queryByRole('button', NO_LEAD)).not.toBeInTheDocument();
    });
  });

  it('draws nothing it may not take for a person with every switch off, but still names the customer', async () => {
    await openFor([]);

    expect(screen.queryByRole('button', ADD_NEW_CLIENT)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', CREATE_LEAD)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', NO_LEAD)).not.toBeInTheDocument();
  });
});

/** What a built-in role's preset values give a person who can also open the dialog (Create estimates + View estimates). */
function personFromPreset(role: PresetRole) {
  return personWith([...new Set([...presetSwitchLabels(role), 'Create estimates', 'View estimates'])]);
}

/** Each opener of the dialog, rendered through its routed file. Each resolves once the dialog is on screen. */
const OPENERS: Array<[string, (person: ReturnType<typeof personWith>) => Promise<void>]> = [
  ['Create New', async ({ ability }) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AbilityProvider ability={ability}>
          <MemoryRouter>
            <AppShell sidebar={<SidebarCreateMenu />} topbar={<div />}><div /></AppShell>
          </MemoryRouter>
        </AbilityProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New Estimate' }));
  }],
  ['the dashboard New menu', async ({ ability }) => {
    renderWithProviders(<NewMenu />, { ability });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New' }));
    await user.click(await screen.findByRole('menuitem', { name: 'New Estimate' }));
  }],
  ['the Estimates list', async ({ ability }) => {
    renderWithProviders(<EstimatesPage />, { ability, initialEntries: ['/estimates?action=new-estimate'] });
  }],
];

describe.each(OPENERS)('opened from %s', (_name, open) => {
  it("a person with the TECHNICIAN preset's values sees no Add new client", async () => {
    const person = personFromPreset('TECHNICIAN');
    serve(person.values);

    await open(person);

    await screen.findByRole('heading', { name: 'Create New Estimate' });
    // The person's answer is cached on this device (see seedMySwitches), so the first paint is already the final one.
    expect(screen.queryByRole('button', ADD_NEW_CLIENT)).not.toBeInTheDocument();
  });

  // The Dispatcher preset holds Create customers and View customers; the Customers page no longer has a switch of its own to
  // hide the entry, so it follows the two (P-AL-10).
  it.each(['SALES', 'DISPATCHER'] as PresetRole[])("a person with the %s preset's values sees Add new client", async (role) => {
    const person = personFromPreset(role);
    serve(person.values);

    await open(person);

    expect(await screen.findByRole('button', ADD_NEW_CLIENT)).toBeInTheDocument();
  });
});
