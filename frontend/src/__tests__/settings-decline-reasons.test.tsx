import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import DeclineReasonsPage from '@/pages/v2/settings/DeclineReasonsPage';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import type { LostReasonOption } from '@/lib/api/lostReasonOptions';
import api from '@/lib/axios';

/**
 * Settings > Estimate Decline Reasons (decline-reasons slice B).
 *
 * The three behaviours worth a test here are the three the plan's decisions turn on, and each
 * of them is a thing the screen must NOT let an admin do:
 *
 *  - D4: there is no way to DELETE a reason, only to switch one off. A declined estimate stores
 *    the reason's code and the conversion report groups on it, so a Remove button would turn
 *    readable history into an orphan string. The assertion is on the absence of the control, not
 *    on a request, because a control that exists and 404s is still a control an admin will press.
 *  - D5: "Other" cannot be switched off. It is where the free-text comment goes.
 *  - A built-in reads as built-in, so an admin can tell which words the rest of the product
 *    already expects and which ones are their own.
 *
 * The list the page is handed here includes an INACTIVE row on purpose: a retired reason that is
 * filtered out of this screen can never be switched back on, which is the failure that makes
 * "deactivate, never delete" worthless.
 */

vi.mock('@/lib/axios', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));

const mockApi = api as unknown as {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
};

const option = (over: Partial<LostReasonOption>): LostReasonOption => ({
  code: 'PRICE',
  label: 'Price',
  is_active: true,
  sort_order: 0,
  is_builtin: true,
  ...over,
});

const LIST: LostReasonOption[] = [
  option({ code: 'PRICE', label: 'Price', sort_order: 0 }),
  option({ code: 'TIMING', label: 'Timing', sort_order: 1, is_active: false }),
  option({ code: 'COMPETITOR', label: 'Went with a competitor', sort_order: 2 }),
  option({ code: 'NO_RESPONSE', label: 'Customer stopped responding', sort_order: 3 }),
  option({ code: 'OTHER', label: 'Other', sort_order: 4 }),
  option({ code: 'WENT_WITH_A_DESIGNER', label: 'Went with a designer', sort_order: 5, is_builtin: false }),
];

/**
 * The page gates itself on `update Organization`, so every case below has to say which user it
 * is rendering as. A bare render carries `emptyAbility` and would land on NotAuthorizedPage with
 * every assertion in this file failing for the wrong reason.
 */
const MANAGER = buildAbility([{ action: 'update', subject: 'Organization' }]);

/** What a SALES rep actually carries here: the coarse read the GET is gated on, and no write. */
const READER = buildAbility([{ action: 'read', subject: 'Estimate' }]);

function renderPage(list: LostReasonOption[] = LIST, ability = MANAGER) {
  mockApi.get.mockResolvedValue({ data: { lost_reason_options: list } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <AbilityProvider ability={ability}>
        <QueryClientProvider client={client}>
          <DeclineReasonsPage />
        </QueryClientProvider>
      </AbilityProvider>
    </MemoryRouter>,
  );
}

/** The row wrapper for one reason, found through its rename field. */
function rowFor(label: string): HTMLElement {
  return screen.getByLabelText(`Rename ${label}`).closest('div') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: {} });
  mockApi.patch.mockResolvedValue({ data: {} });
});

describe('Settings -> Estimate Decline Reasons', () => {
  it('lists every reason, inactive ones included, so a retired one can be switched back on (D4)', async () => {
    renderPage();

    // Timing is inactive in the fixture. If this screen hid it, an admin could never restore it.
    const timing = await screen.findByLabelText('Rename Timing');
    expect(timing).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Offer Timing when an estimate is declined' })).not.toBeChecked();
    expect(screen.getByText('5 of 6 offered')).toBeInTheDocument();
  });

  it('offers no way to delete a reason, on any row (D4)', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');

    // Named individually as well as swept, so a Remove button added to ONE row - the custom
    // reason is the tempting one - is still a failure.
    for (const label of ['Price', 'Other', 'Went with a designer']) {
      const row = rowFor(label);
      expect(within(row).queryByRole('button', { name: /remove|delete/i })).toBeNull();
    }
    expect(screen.queryAllByRole('button', { name: /remove|delete/i })).toEqual([]);
  });

  it('will not let "Other" be switched off (D5)', async () => {
    renderPage();

    const other = await screen.findByRole('switch', { name: 'Other is always offered' });
    expect(other).toBeDisabled();

    await userEvent.click(other);
    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('marks the reasons ServWave ships with, and leaves a hand-added one unmarked', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');

    expect(within(rowFor('Price')).getByText('Built-in')).toBeInTheDocument();
    expect(within(rowFor('Other')).getByText('Built-in')).toBeInTheDocument();
    expect(within(rowFor('Went with a designer')).queryByText('Built-in')).toBeNull();
  });

  it('renames on blur, by code, and not once per keystroke', async () => {
    renderPage();

    const field = await screen.findByLabelText('Rename Price');
    await userEvent.clear(field);
    await userEvent.type(field, 'Too expensive');
    // Still nothing sent: a PATCH per keystroke would be thirteen writes and a racing list.
    expect(mockApi.patch).not.toHaveBeenCalled();

    fireEvent.blur(field);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/lost-reason-options/PRICE', { label: 'Too expensive' }),
    );
  });

  it('sends nothing when a rename is blurred unchanged', async () => {
    renderPage();

    const field = await screen.findByLabelText('Rename Price');
    fireEvent.blur(field);

    expect(mockApi.patch).not.toHaveBeenCalled();
  });

  it('switches a built-in off rather than removing it (D4)', async () => {
    renderPage();

    const toggle = await screen.findByRole('switch', {
      name: 'Offer Went with a competitor when an estimate is declined',
    });
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/lost-reason-options/COMPETITOR', { is_active: false }),
    );
  });

  it('switches a retired reason back on', async () => {
    renderPage();

    const toggle = await screen.findByRole('switch', { name: 'Offer Timing when an estimate is declined' });
    await userEvent.click(toggle);

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/lost-reason-options/TIMING', { is_active: true }),
    );
  });

  it('adds a reason from the trimmed label and clears the field', async () => {
    renderPage();

    const field = await screen.findByLabelText('New decline reason');
    await userEvent.type(field, '  Quality  ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/lost-reason-options', { label: 'Quality' }),
    );
    expect(field).toHaveValue('');
  });

  it('will not add a blank reason', async () => {
    renderPage();

    const field = await screen.findByLabelText('New decline reason');
    await userEvent.type(field, '   ');

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('reorders by dragging one reason onto another, sending the whole new order', async () => {
    renderPage();
    await screen.findByLabelText('Rename Price');

    const source = rowFor('Went with a designer');
    const target = rowFor('Price');

    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    fireEvent.dragOver(target);
    fireEvent.drop(target, { dataTransfer: { getData: () => 'WENT_WITH_A_DESIGNER' } });

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/lost-reason-options/reorder', {
        ordered_codes: ['WENT_WITH_A_DESIGNER', 'PRICE', 'TIMING', 'COMPETITOR', 'NO_RESPONSE', 'OTHER'],
      }),
    );
  });

  it('renders the built-ins an un-customised organisation reads, with no empty state', async () => {
    // The server answers the five built-ins for an org that has never saved (D3), so this page
    // never legitimately shows an empty list - and an "add your first reason" prompt would be a
    // lie about what a customer is currently offered.
    renderPage(LIST.slice(0, 5));

    await screen.findByLabelText('Rename Price');
    expect(screen.getByText('4 of 5 offered')).toBeInTheDocument();
  });
});

/**
 * Who may open this screen at all.
 *
 * `/settings/*` has no route-level guard, and SettingsLayout CASL-filters the nav LIST only, so
 * the hidden nav row stops a non-admin CLICKING here and not a non-admin TYPING the URL. And the
 * usual backstop - "the API 403s the read, so the page comes up empty" - does not apply, because
 * the GET is gated on the deliberately coarser `read Estimate` that slice C needs. A SALES rep
 * who typed the URL therefore got the organisation's REAL list, every row of it wrapped in a
 * rename field, a toggle and a drag handle, under an Add button, and every one of those writes
 * came back 403 as a toast.
 *
 * So the page gates itself, on the same `update Organization` its four writes are gated on.
 */
describe('Settings -> Estimate Decline Reasons: who can open it', () => {
  it('shows a non-admin who deep-links the URL that they have no access, not the list', async () => {
    renderPage(LIST, READER);

    expect(await screen.findByText(/don’t have access to this page/i)).toBeInTheDocument();

    // The specific failure being pinned: a populated, working-looking editor. Each control is
    // named on its own because losing any ONE of them back to the page is the whole defect.
    expect(screen.queryByLabelText('Rename Price')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('New decline reason')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/offered$/)).not.toBeInTheDocument();
  });

  it('asks the server for nothing when the user cannot manage the list', async () => {
    // The gate is a wrapper, not a branch inside the body, so a refused user never mounts the
    // hooks. A page that 403-storms on behalf of someone it just told to go away is noise in the
    // logs and a slower way to say no.
    renderPage(LIST, READER);
    await screen.findByText(/don’t have access to this page/i);

    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('lets a custom role that carries update Organization manage it, without being ADMIN', async () => {
    // Gated on the CASL pair rather than on `role === 'ADMIN'`: the roles UI can grant this pair
    // to a custom role, the API honours it on all four writes, and a role check here would lock
    // that role out of a page the server lets it write.
    renderPage(LIST, buildAbility([
      { action: 'read', subject: 'Estimate' },
      { action: 'update', subject: 'Organization' },
    ]));

    expect(await screen.findByLabelText('Rename Price')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });
});
