/**
 * #2026 slices 1–3 — the estimate tab strip follows the estimate's ANCHOR, not just its lead.
 *
 * The strip took a `leadId` and the workspace rendered it only when the estimate had one, so a
 * customer-anchored or job-anchored estimate had no way to reach its siblings or to add another.
 * It also labelled an unnamed estimate by its POSITION in the list, which agrees with the
 * estimate number only while the container's numbering happens to be dense.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { EstimateTabs } from '@/features/estimate-workspace/components/EstimateTabs';

const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';
const LEAD_ID = '10000000-0000-0000-0000-0000000000bb';
const JOB_ID = 'a0000000-0000-0000-0000-0000000000cc';

// The strip gates "+ Add estimate" on `create Estimate`; renderWithProviders' default ability
// denies everything, so grant it here rather than leaving the button out of every assertion.
vi.mock('@/contexts/AbilityContext', async () => {
  const actual = await vi.importActual<typeof import('@/contexts/AbilityContext')>('@/contexts/AbilityContext');
  return { ...actual, useAppAbility: () => ({ can: () => true }) };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

function estimate(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    estimate_number: 'E00001',
    name: null,
    status: 'DRAFT',
    created_at: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/** The params the strip actually asked the list endpoint for. */
function listParams(): Record<string, unknown> {
  const call = vi.mocked(api.get).mock.calls.find(([url]) => url === '/api/estimates');
  if (!call) throw new Error('the strip never queried the estimate list');
  return (call[1] as { params: Record<string, unknown> }).params;
}

function mockList(estimates: unknown[]) {
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/api/estimates') return { data: { estimates } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList([estimate()]);
});

describe('the estimate tab strip', () => {
  it('asks for the estimates anchored to a customer, and nothing that merely reaches them', async () => {
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'customer', id: CUSTOMER_ID }} activeEstimateId="e1" />,
    );

    await screen.findByRole('button', { name: /estimate 1/i });
    expect(listParams()).toMatchObject({ customer_id: CUSTOMER_ID, anchor: 'customer' });
  });

  it('asks for the estimates anchored to a job', async () => {
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'job', id: JOB_ID }} activeEstimateId="e1" />,
    );

    await screen.findByRole('button', { name: /estimate 1/i });
    expect(listParams()).toMatchObject({ job_id: JOB_ID, anchor: 'job' });
  });

  it('asks for the estimates anchored to a lead', async () => {
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'lead', id: LEAD_ID }} activeEstimateId="e1" />,
    );

    await screen.findByRole('button', { name: /estimate 1/i });
    expect(listParams()).toMatchObject({ lead_id: LEAD_ID, anchor: 'lead' });
  });

  it('marks the current estimate active and navigates to a sibling on click', async () => {
    const user = userEvent.setup();
    mockList([estimate(), estimate({ id: 'e2', estimate_number: 'E00002', created_at: '2026-09-02T00:00:00Z' })]);
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'customer', id: CUSTOMER_ID }} activeEstimateId="e1" />,
    );

    const first = await screen.findByRole('button', { name: /estimate 1/i });
    expect(first).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('button', { name: /estimate 2/i }));
    expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining('/estimates/e2'));
  });

  it('shows the one tab plus Add estimate when the anchor holds a single estimate', async () => {
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'customer', id: CUSTOMER_ID }} activeEstimateId="e1" />,
    );

    expect(await screen.findByRole('button', { name: /estimate 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add estimate/i })).toBeInTheDocument();
  });
});

// ─── #2026 slice 3 — labels come from the estimate number, not the position ───

describe('a tab label', () => {
  it("shows the estimate's name when it has one", async () => {
    mockList([estimate({ name: 'Good — single door' })]);
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'customer', id: CUSTOMER_ID }} activeEstimateId="e1" />,
    );

    expect(await screen.findByRole('button', { name: 'Good — single door' })).toBeInTheDocument();
  });

  it("falls back to the estimate's own number within its container, not its position", async () => {
    // E00001 was deleted, leaving a gap. Position would label these 1 and 2; their own numbers
    // say 2 and 3, and the workspace title shows those.
    mockList([
      estimate({ id: 'e2', estimate_number: 'E00002', created_at: '2026-09-02T00:00:00Z' }),
      estimate({ id: 'e3', estimate_number: 'E00003', created_at: '2026-09-03T00:00:00Z' }),
    ]);
    renderWithProviders(
      <EstimateTabs anchor={{ kind: 'customer', id: CUSTOMER_ID }} activeEstimateId="e2" />,
    );

    expect(await screen.findByRole('button', { name: 'Estimate 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estimate 3' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Estimate 1' })).not.toBeInTheDocument();
  });
});
