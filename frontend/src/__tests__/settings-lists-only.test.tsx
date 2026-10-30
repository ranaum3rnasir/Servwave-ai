import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
/**
 * Imports `@/pages/v2/settings/ListsPage`, NOT `@/pages/settings/PaymentsListsPage`: the route mounts the v2
 * fork, and the v1 file is dead code. The payments cards that used to sit on this page moved to
 * Settings > ServWave Payments (servwave-payments-page.test.tsx); this page is the Lists half until it is replaced.
 */
import ListsPage from '@/pages/v2/settings/ListsPage';
import { buildAbility } from '@/lib/ability';
import { installListsServer, row } from './listsFake';

const mockApi = vi.mocked(api);

const ORG = {
  id: 'o1',
  stripe_connected: false,
  accepted_payment_methods: ['CASH'],
  source_options: ['Google'],
  job_type_options: [],
};

const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);

function serve(fallback: (m: string, url: string) => unknown = (_m, url) => (url === '/api/organization' ? ORG : {})) {
  return installListsServer(
    mockApi,
    {
      '/api/job-types': { rows: [row('j1', 'Repair')] },
      '/api/lead-sources': { rows: [row('s1', 'Google')] },
    },
    fallback,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

describe('ListsPage - Lists only', () => {
  it('renders the lists, and none of the payments cards that moved to ServWave Payments', async () => {
    renderWithProviders(<ListsPage />, { ability: PAGE });
    expect(await screen.findByText('Lead/Customer sources')).toBeInTheDocument();
    expect(screen.getByText('Job types')).toBeInTheDocument();
    for (const moved of ['Accepted Payment Methods', 'Accepted payment methods', 'Default deposit', 'Default Deposit', 'Tips', 'Bank-transfer instructions']) {
      expect(screen.queryByText(moved)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('Estimate Document Copy')).not.toBeInTheDocument();
  });

  it('creates a source row through the card, not through the organization record', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    await screen.findByText('Google');

    await user.click(screen.getByRole('button', { name: 'Create source' }));
    await user.type(screen.getByLabelText('Name of the new source'), 'Referral{Enter}');
    expect(await screen.findByText('Referral')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalledWith('/api/organization', expect.anything());
  });

  it('turns away someone who may not change company settings', async () => {
    renderWithProviders(<ListsPage />, { ability: buildAbility([{ action: 'read', subject: 'Organization' }]) });
    expect(await screen.findByText(/don.t have access/i)).toBeInTheDocument();
    expect(screen.queryByText('Job types')).not.toBeInTheDocument();
  });
});

describe('ListsPage - tag management gate', () => {
  // `update`/`delete Tag` carry no defaultGrants row, so only ADMIN (`manage all`)
  // holds both. A dispatcher or salesperson can still read and create tags from a
  // record, but must not see the org-wide rename/delete surface.
  const ADMIN = buildAbility([
    { action: 'update', subject: 'Organization' },
    { action: 'update', subject: 'Tag' },
    { action: 'delete', subject: 'Tag' },
  ]);
  const NON_ADMIN = buildAbility([
    { action: 'update', subject: 'Organization' },
    { action: 'read', subject: 'Tag' },
    { action: 'create', subject: 'Tag' },
  ]);

  beforeEach(() => {
    serve((_m, url) => (url === '/api/organization' ? ORG : url === '/api/tags' ? { tags: [{ id: 't1', name: 'Urgent', color: '#EF4444' }] } : {}));
  });

  it('shows the Tags card to an admin', async () => {
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    expect(await screen.findByText('Urgent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions for Urgent' })).toBeInTheDocument();
  });

  it('hides the Tags card from a non-admin who can still create tags', async () => {
    renderWithProviders(<ListsPage />, { ability: NON_ADMIN });
    // The rest of the page still renders - only the tag card is withheld.
    expect(await screen.findByText('Lead/Customer sources')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions for Urgent' })).not.toBeInTheDocument();
  });
});
