import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import JobCancelReasonsPage from '@/pages/v2/settings/JobCancelReasonsPage';
import SettingsLayout from '@/pages/v2/settings/SettingsLayout';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import type { JobCancelReason } from '@/lib/api/jobCancelReasons';
import api from '@/lib/axios';

/**
 * Settings > Job Cancel Reasons (Roles & Permissions, S06.14): the job twin of Estimate Decline Reasons.
 *
 * A reason can be renamed, added, reordered and switched off, never removed (a cancelled job holds its code), and
 * "Other" can't be switched off. The page and its nav row follow Company settings, the pair the four writes are
 * gated on, and an editing list belongs to the job cancel route and never to the estimate one.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

const reason = (over: Partial<JobCancelReason>): JobCancelReason => ({
  code: 'PRICE',
  label: 'Price',
  is_active: true,
  sort_order: 0,
  is_builtin: true,
  ...over,
});

const LIST: JobCancelReason[] = [
  reason({ code: 'CUSTOMER_BACKED_OUT', label: 'Customer backed out', sort_order: 0 }),
  reason({ code: 'PRICE', label: 'Price', sort_order: 1 }),
  reason({ code: 'DUPLICATE_JOB', label: 'Duplicate job', sort_order: 2, is_active: false }),
  reason({ code: 'OTHER', label: 'Other', sort_order: 3 }),
  reason({ code: 'PERMIT_REFUSED', label: 'Permit refused', sort_order: 4, is_builtin: false }),
];

const MANAGER = buildAbility([{ action: 'update', subject: 'Organization' }]);
/** Someone who can cancel jobs and read the company, but not edit its settings. */
const NON_MANAGER = buildAbility([
  { action: 'read', subject: 'Organization' },
  { action: 'read', subject: 'Job' },
]);

function renderPage(list: JobCancelReason[] = LIST, ability = MANAGER) {
  mockApi.get.mockResolvedValue({ data: { job_cancel_reasons: list } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <AbilityProvider ability={ability}>
        <QueryClientProvider client={client}>
          <JobCancelReasonsPage />
        </QueryClientProvider>
      </AbilityProvider>
    </MemoryRouter>,
  );
}

const rowFor = (label: string) => screen.getByLabelText(`Rename ${label}`).closest('div') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.patch.mockResolvedValue({ data: {} });
});

describe('Settings -> Job Cancel Reasons', () => {
  it('reads the job route, lists every reason with the switched-off one included, and counts what is offered', async () => {
    renderPage();

    expect(await screen.findByLabelText('Rename Duplicate job')).toBeInTheDocument();
    expect(mockApi.get).toHaveBeenCalledWith('/api/job-cancel-reasons');
    expect(screen.getByRole('switch', { name: 'Offer Duplicate job when a job is cancelled' })).not.toBeChecked();
    expect(screen.getByText('4 of 5 offered')).toBeInTheDocument();
  });

  it('offers no way to remove a reason, on any row', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');
    expect(screen.queryAllByRole('button', { name: /remove|delete/i })).toEqual([]);
  });

  it('will not let "Other" be switched off', async () => {
    renderPage();
    const other = await screen.findByRole('switch', { name: 'Other is always offered' });
    expect(other).toBeDisabled();
    await userEvent.click(other);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('marks the built-ins and leaves a hand-added reason unmarked', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');
    expect(within(rowFor('Price')).getByText('Built-in')).toBeInTheDocument();
    expect(within(rowFor('Permit refused')).queryByText('Built-in')).toBeNull();
  });

  it('renames on blur, by code, and not once per keystroke', async () => {
    renderPage();
    const field = await screen.findByLabelText('Rename Price');
    await userEvent.clear(field);
    await userEvent.type(field, 'Too expensive');
    expect(mockApi.patch).not.toHaveBeenCalled();
    fireEvent.blur(field);
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/job-cancel-reasons/PRICE', { label: 'Too expensive' }),
    );
  });

  it('switches a reason off, and a retired one back on', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Offer Price when a job is cancelled' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/job-cancel-reasons/PRICE', { is_active: false }),
    );
    await userEvent.click(screen.getByRole('switch', { name: 'Offer Duplicate job when a job is cancelled' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/job-cancel-reasons/DUPLICATE_JOB', { is_active: true }),
    );
  });

  it('adds a reason from the trimmed label and clears the field, and will not add a blank one', async () => {
    renderPage();
    const field = await screen.findByLabelText('New cancel reason');
    await userEvent.type(field, '   ');
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, '  Weather  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/job-cancel-reasons', { label: 'Weather' }));
    expect(field).toHaveValue('');
  });

  it('reorders with Move up, sending the whole new order', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');
    await userEvent.click(within(rowFor('Price')).getByRole('button', { name: /move .*up/i }));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/job-cancel-reasons/reorder', {
        ordered_codes: ['PRICE', 'CUSTOMER_BACKED_OUT', 'DUPLICATE_JOB', 'OTHER', 'PERMIT_REFUSED'],
      }),
    );
  });

  it('reorders by dragging one reason onto another', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');
    const source = rowFor('Permit refused');
    const target = rowFor('Customer backed out');
    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    fireEvent.dragOver(target);
    fireEvent.drop(target, { dataTransfer: { getData: () => 'PERMIT_REFUSED' } });
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/job-cancel-reasons/reorder', {
        ordered_codes: ['PERMIT_REFUSED', 'CUSTOMER_BACKED_OUT', 'PRICE', 'DUPLICATE_JOB', 'OTHER'],
      }),
    );
  });

  it('never reads or writes the estimate decline reasons', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('switch', { name: 'Offer Price when a job is cancelled' }));
    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    const urls = [...mockApi.get.mock.calls, ...mockApi.post.mock.calls, ...mockApi.patch.mock.calls].map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('lost-reason-options'))).toBe(false);
  });
});

describe('Settings -> Job Cancel Reasons: who can open it', () => {
  it('shows someone without Company settings that they have no access, and asks the server for nothing', async () => {
    renderPage(LIST, NON_MANAGER);
    expect(await screen.findByText(/don’t have access to this page/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Rename Price')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});

describe('Settings nav: Job Cancel Reasons', () => {
  function renderShell(ability: ReturnType<typeof buildAbility>) {
    vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        user: {
          id: 'u-1', email: 'a@test.com', first_name: 'Test', last_name: 'Admin',
          role: 'ADMIN', org_is_demo: true, organization_id: 'org-demo', org_features: [],
        },
        isAuthenticated: true, isLoading: false, error: null,
      })) as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <MemoryRouter initialEntries={['/settings/job-cancel-reasons']}>
        <AbilityProvider ability={ability}>
          <QueryClientProvider client={client}>
            <Routes>
              <Route path="/settings" element={<SettingsLayout />}>
                <Route path="/settings/job-cancel-reasons" element={<p>page</p>} />
              </Route>
            </Routes>
          </QueryClientProvider>
        </AbilityProvider>
      </MemoryRouter>,
    );
  }

  it('sits beside Estimate Decline Reasons for someone who can edit company settings', () => {
    renderShell(MANAGER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    const links = within(nav).getAllByRole('link').map((a) => a.textContent);
    const decline = links.indexOf('Estimate Decline Reasons');
    expect(decline).toBeGreaterThan(-1);
    expect(links[decline + 1]).toBe('Job Cancel Reasons');
  });

  it('is hidden from someone who cannot', () => {
    renderShell(NON_MANAGER);
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryByRole('link', { name: 'Job Cancel Reasons' })).toBeNull();
  });
});
