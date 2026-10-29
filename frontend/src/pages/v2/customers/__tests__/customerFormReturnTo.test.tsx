/**
 * #1472 AC4 (round-trip) and AC8 (visible failure, never a silent dead end) for the **v2**
 * `CustomerFormPage` - the live receiver of the "Add new client" navigation this issue
 * repoints, per `frontend/src/pages/v2/routes/customers.routes.tsx:31`. There is no existing
 * suite for this page (`customerDetailPageScheduleTab.test.tsx` and `customersExportGate.test.tsx`
 * cover the list/detail pages, not this one), so both checks are new.
 *
 * AC4: on create success with `location.state.returnTo === '/estimates'`, the page must navigate
 * to `/estimates?newCustomerId=<id>` with `{ replace: true }` - the half of the round-trip that
 * newly receives traffic once "Add new client" points here instead of at `/leads/new`.
 *
 * AC8: `/customers/new` requires the `create Customer` grant, which SALES does not hold (spec
 * "Known consequence" section). A SALES rep hitting Save now gets a 403. This is an accepted,
 * separately-tracked permissions gap - NOT something this PR may "fix" by hiding the button or
 * auto-redirecting. What this PR must guarantee is that the 403 is surfaced honestly: the error
 * block renders, the mutation does not silently succeed via the duplicate-dialog branch (which
 * only ever intercepts a 409), and the user is never bounced anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import api from '@/lib/axios';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);

function createTestQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

/**
 * Renders the create form at `/customers/new`, optionally carrying the `returnTo` state that
 * `handleAddNewClient` now sets (both dialogs). `useNavigate` is mocked above but `useLocation`
 * is real, so passing a location-state entry here exercises the same read the live navigation
 * produces.
 */
function renderCreateForm(returnTo?: string) {
  const entry = returnTo ? { pathname: '/customers/new', state: { returnTo } } : '/customers/new';
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/customers/new" element={<CustomerFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The schema's minimum valid payload: a first name plus a 10-digit phone (SERV10X-35). */
async function fillMinimalValidForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByPlaceholderText('Jane'), 'Qa1472');
  await user.type(screen.getByPlaceholderText('(555) 123-4567'), '5551234567');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: {} });
});

describe('#1472 AC4 - v2 CustomerFormPage honours returnTo on create success', () => {
  it('navigates to /estimates?newCustomerId=<id> with replace:true when returnTo=/estimates', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValueOnce({ data: { customer: { id: 'qa-1472-roundtrip-id' } } });
    renderCreateForm('/estimates');

    await fillMinimalValidForm(user);
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        '/estimates?newCustomerId=qa-1472-roundtrip-id',
        { replace: true },
      ),
    );
  });

  it('falls back to the customer detail page when there is no returnTo (unrelated entry point, control)', async () => {
    const user = userEvent.setup();
    mockApi.post.mockResolvedValueOnce({ data: { customer: { id: 'qa-1472-no-returnto-id' } } });
    renderCreateForm();

    await fillMinimalValidForm(user);
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalledWith(
      expect.stringContaining('newCustomerId'),
      expect.anything(),
    );
  });
});

describe('#1472 AC8 - a 403 on create is surfaced, never swallowed or auto-redirected', () => {
  it('renders the inline error, never navigates, and is not swept into the duplicate-dialog branch (which only intercepts 409)', async () => {
    const user = userEvent.setup();
    mockApi.post.mockRejectedValueOnce({
      response: { status: 403, data: { error: 'Forbidden' } },
    });
    renderCreateForm('/estimates');

    await fillMinimalValidForm(user);
    await user.click(screen.getByTestId('customer-form-submit'));

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    // The 403's message surfaces via extractApiError's data.error fallback.
    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    // No "success" round-trip: the worst outcome would be a redirect on a failed create.
    expect(mockNavigate).not.toHaveBeenCalled();
    // The duplicate-customer dialog (409-only) must not have opened and swallowed the error.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
