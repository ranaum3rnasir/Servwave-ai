import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import UserPermissionsDialog from '@/components/settings/UserPermissionsDialog';

// The global axios mock (src/__tests__/setup.ts) defines get/post/patch/delete
// but not `put`; the permissions mutation uses PUT, so attach a local mock here.
const putMock = vi.fn();
(api as unknown as { put: typeof putMock }).put = putMock;
const mockApi = vi.mocked(api);

// Multi-capability response from GET /api/users/:id/permissions. The backend now
// returns the full managed set (13 capabilities); the UI must render all of them
// data-driven, not a hardcoded single `create Invoice` row. Two subjects so we can
// also assert the subject grouping.
const MULTI_PERMISSIONS = {
  user_id: 'u1',
  editable: true,
  capabilities: [
    {
      action: 'create',
      subject: 'Invoice',
      label: 'Create invoices',
      description: 'Generate invoices for jobs.',
      roleDefault: 'not-in-role' as const,
      override: 'inherit' as const,
      effective: false,
    },
    {
      action: 'record_payment',
      subject: 'Invoice',
      label: 'Record payments',
      description: 'Record payments against invoices.',
      roleDefault: 'not-in-role' as const,
      override: 'allow' as const,
      effective: true,
    },
    {
      action: 'create',
      subject: 'Estimate',
      label: 'Create estimates',
      description: 'Draft estimates for leads.',
      roleDefault: 'allowed' as const,
      override: 'inherit' as const,
      effective: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/users/u1/permissions')
      return Promise.resolve({ data: MULTI_PERMISSIONS });
    return Promise.resolve({ data: {} });
  });
  putMock.mockResolvedValue({ data: { ok: true } });
});

describe('UserPermissionsDialog — renders N capabilities from the API', () => {
  it('renders every managed capability the API returns, grouped by subject', async () => {
    renderWithProviders(
      <UserPermissionsDialog userId="u1" userName="Tess Tech" onClose={() => {}} />,
    );

    // All three capabilities render (not just `create Invoice`).
    expect(await screen.findByText('Create invoices')).toBeInTheDocument();
    expect(screen.getByText('Record payments')).toBeInTheDocument();
    expect(screen.getByText('Create estimates')).toBeInTheDocument();

    // Grouped by subject — both Invoice and Estimate headers present.
    expect(screen.getByText('Invoice')).toBeInTheDocument();
    expect(screen.getByText('Estimate')).toBeInTheDocument();

    // Each capability has its own tri-state group (a11y from PR #228).
    const groups = screen.getAllByRole('group', { name: /^Override for / });
    expect(groups).toHaveLength(3);
  });

  it('reflects each capability’s server override state via aria-pressed', async () => {
    renderWithProviders(
      <UserPermissionsDialog userId="u1" userName="Tess Tech" onClose={() => {}} />,
    );
    await screen.findByText('Create invoices');

    // `create Invoice` is inherited → Inherit pressed, Allow not pressed.
    const invoiceGroup = screen.getByRole('group', { name: 'Override for Create invoices' });
    expect(within(invoiceGroup).getByRole('button', { name: 'Inherit' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(invoiceGroup).getByRole('button', { name: 'Allow' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // `record_payment Invoice` is allow → Allow pressed.
    const payGroup = screen.getByRole('group', { name: 'Override for Record payments' });
    expect(within(payGroup).getByRole('button', { name: 'Allow' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('toggling one capability PUTs only that override with the correct effect', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <UserPermissionsDialog userId="u1" userName="Tess Tech" onClose={onClose} />,
    );
    await screen.findByText('Create invoices');

    // Set `create Invoice` to Allow (was Inherit). `record_payment Invoice` is
    // already Allow on the server, so the saved payload carries both allow rows;
    // `create Estimate` stays Inherit and is therefore omitted.
    const invoiceGroup = screen.getByRole('group', { name: 'Override for Create invoices' });
    await user.click(within(invoiceGroup).getByRole('button', { name: 'Allow' }));

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/users/u1/permissions', {
        overrides: expect.arrayContaining([
          { action: 'create', subject: 'Invoice', effect: 'allow' },
          { action: 'record_payment', subject: 'Invoice', effect: 'allow' },
        ]),
      }),
    );
    // Inherited capability is not sent.
    const sent = putMock.mock.calls[0][1] as { overrides: { subject: string }[] };
    expect(sent.overrides).toHaveLength(2);
    expect(sent.overrides.some((o) => o.subject === 'Estimate')).toBe(false);
  });
});

// Inventory P3 (D10/D13) — the `location_restricted:Inventory` capability is registered in
// USER_CAPABILITIES server-side; the dialog is fully data-driven, so it must render the new
// row under an "Inventory" subject group and round-trip an Allow (= restriction ON) without
// any dialog changes.
describe('UserPermissionsDialog — Inventory van-restriction capability (P3)', () => {
  const WITH_INVENTORY_CAPABILITY = {
    user_id: 'u1',
    editable: true,
    capabilities: [
      ...MULTI_PERMISSIONS.capabilities,
      {
        action: 'location_restricted',
        subject: 'Inventory',
        label: 'Restrict inventory to their van',
        description:
          "When on, this technician's stock deductions are locked to their assigned van — any other location is refused.",
        roleDefault: 'not-in-role' as const,
        override: 'inherit' as const,
        effective: false,
      },
    ],
  };

  beforeEach(() => {
    mockApi.get.mockImplementation((url: string) => {
      if (url === '/api/users/u1/permissions')
        return Promise.resolve({ data: WITH_INVENTORY_CAPABILITY });
      return Promise.resolve({ data: {} });
    });
  });

  it('renders the capability under an "Inventory" group with its label', async () => {
    renderWithProviders(
      <UserPermissionsDialog userId="u1" userName="Tess Tech" onClose={() => {}} />,
    );

    expect(await screen.findByText('Restrict inventory to their van')).toBeInTheDocument();
    expect(screen.getByText('Inventory')).toBeInTheDocument();
    // Its own tri-state group exists alongside the three baseline capabilities.
    expect(
      screen.getByRole('group', { name: 'Override for Restrict inventory to their van' }),
    ).toBeInTheDocument();
  });

  it('Allow round-trips: toggling to Allow PUTs the location_restricted override', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <UserPermissionsDialog userId="u1" userName="Tess Tech" onClose={() => {}} />,
    );
    await screen.findByText('Restrict inventory to their van');

    const group = screen.getByRole('group', {
      name: 'Override for Restrict inventory to their van',
    });
    await user.click(within(group).getByRole('button', { name: 'Allow' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(putMock).toHaveBeenCalledWith('/api/users/u1/permissions', {
        overrides: expect.arrayContaining([
          { action: 'location_restricted', subject: 'Inventory', effect: 'allow' },
        ]),
      }),
    );
  });
});

describe('UserPermissionsDialog — admin target immune', () => {
  it('shows the immutable notice and disables Save when the target is not editable', async () => {
    mockApi.get.mockResolvedValue({
      data: { user_id: 'admin1', editable: false, capabilities: [] },
    });
    renderWithProviders(
      <UserPermissionsDialog userId="admin1" userName="Anna Admin" onClose={() => {}} />,
    );

    expect(await screen.findByText(/full access, which can’t be overridden/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
