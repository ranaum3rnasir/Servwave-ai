/**
 * Roles & Permissions security, ticket 36b (M17), finding M2: a screen shows the pointer to a Settings page to an Admin only.
 *
 * "No options - add in Settings" and "Go to Settings -> Job Sub-Statuses" name pages that render nothing for anyone who is not an
 * Admin. An Admin keeps the pointer word for word; anyone else sees "No options", or the empty-state text without the link. The
 * source guard (settings-pointers-admin-only.guard.test.ts) fails on a pointer added later that skips this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { useIsAdmin, useNoOptionsLabel } from '@/lib/useIsAdmin';
import SubStatusPicker from '@/components/workflows/trigger/SubStatusPicker';
import { MarkSentDialog } from '@/components/estimates/MarkSentDialog';
import { renderWithProviders } from './helpers';

const mockApi = vi.mocked(api);

vi.mock('@/lib/api/shared/organization', () => ({
  useOrganization: () => ({ data: { deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, accepted_payment_methods: [] } }),
}));
vi.mock('@/components/payments/PaymentsSetupBanner', () => ({ PaymentsSetupBanner: () => null }));

function signedIn(isAdmin: boolean) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'person@test.com', first_name: 'Test', last_name: 'Person', role: 'DISPATCHER', is_admin: isAdmin },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { job_sub_statuses: [] } });
});

describe('the empty option list', () => {
  it('names where to add options for an Admin, and says only "No options" to anyone else', () => {
    signedIn(true);
    expect(renderHook(() => useIsAdmin()).result.current).toBe(true);
    expect(renderHook(() => useNoOptionsLabel()).result.current).toBe('No options - add in Settings');
    expect(renderHook(() => useNoOptionsLabel('add some in Settings')).result.current).toBe('No options - add some in Settings');

    signedIn(false);
    expect(renderHook(() => useIsAdmin()).result.current).toBe(false);
    expect(renderHook(() => useNoOptionsLabel()).result.current).toBe('No options');
    expect(renderHook(() => useNoOptionsLabel('add some in Settings')).result.current).toBe('No options');
  });
});

describe('the workflow trigger with no job sub-statuses yet', () => {
  it('links an Admin to the page that adds them', async () => {
    signedIn(true);
    renderWithProviders(<SubStatusPicker value={null} onPick={vi.fn()} />);
    expect(await screen.findByText('No job sub-statuses yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Settings → Job Sub-Statuses' })).toHaveAttribute('href', '/settings/job-sub-statuses');
  });

  it('says the same without the link to anyone who is not an Admin', async () => {
    signedIn(false);
    renderWithProviders(<SubStatusPicker value={null} onPick={vi.fn()} />);
    expect(await screen.findByText('No job sub-statuses yet')).toBeInTheDocument();
    expect(screen.getByText(/This trigger has no label to watch until your org adds one/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Settings/ })).not.toBeInTheDocument();
  });
});

describe('the estimate dialog with no payment methods accepted', () => {
  const open = () => renderWithProviders(
    <MarkSentDialog open onOpenChange={() => {}} estimateId="est-1" estimateNumber="J00229-2" totalAmount={106.63} onSuccess={() => {}} />,
  );

  it('tells an Admin where to update them', () => {
    signedIn(true);
    open();
    expect(screen.getByText('No payment methods accepted by your organization. Update them in Organization Settings.')).toBeInTheDocument();
  });

  it('says only that none are accepted to anyone who is not an Admin', () => {
    signedIn(false);
    open();
    expect(screen.getByText('No payment methods accepted by your organization.')).toBeInTheDocument();
    expect(screen.queryByText(/Organization Settings/)).not.toBeInTheDocument();
  });
});
