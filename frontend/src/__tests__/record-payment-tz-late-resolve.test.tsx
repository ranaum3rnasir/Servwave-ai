/**
 * Defect C, the payments half - see `pages/v2/jobs/__tests__/visitScheduleTzLateResolve.test.tsx`
 * for the full statement of the defect.
 *
 * RecordPaymentDialog is the MOST exposed of the three write-path seeds: its own comment records
 * that "the dialog stays mounted while closed", and all three hosts render it unconditionally, so
 * it seeds `paidAt` with the page, not on open - the earliest possible moment, and the likeliest
 * to be inside the org query's flight.
 *
 * America/Denver deliberately. Under an Eastern org the fallback equals the truth and the
 * assertion below holds against the broken code too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';

const ORG_TZ = 'America/Denver'; // MDT (UTC-6) in June.

interface OrgQueryState {
  data: { id: string; timezone: string | null } | undefined;
  isLoading: boolean;
  isError: boolean;
}

const orgMock = vi.hoisted(() => ({
  state: { data: undefined, isLoading: true, isError: false } as OrgQueryState,
}));

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => orgMock.state };
});

const post = vi.fn();
vi.mock('@/lib/axios', () => ({ default: { post: (...a: unknown[]) => post(...a) } }));

function resolveOrg() {
  orgMock.state = { data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false };
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // A FRESH element every time - see the twin note in visitScheduleTzLateResolve.test.tsx.
  const ui = () => (
    <QueryClientProvider client={qc}>
      <RecordPaymentDialog
        open
        onOpenChange={vi.fn()}
        invoiceId="inv-1"
        invoiceNumber="I00001"
        amountDue={900}
        onSuccess={vi.fn()}
      />
    </QueryClientProvider>
  );
  const view = render(ui());
  return { ...view, replay: () => view.rerender(ui()) };
}

describe('RecordPaymentDialog - the org timezone can land after the dialog has seeded', () => {
  beforeEach(() => {
    orgMock.state = { data: undefined, isLoading: true, isError: false };
    post.mockReset().mockResolvedValue({ data: {} });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-06-15T18:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the payment at the true instant when the org timezone resolves after mount', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { replay } = renderDialog();

    resolveOrg();
    replay();

    await user.click(screen.getByRole('button', { name: /record payment/i }));

    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/api/invoices/inv-1/payments');
    // Seeded as 14:00 on the Eastern fallback and submitted back through Denver, an untouched
    // Date field books the payment two hours late. Nobody typed anything for that to happen.
    expect(body.paid_at).toBe('2026-06-15T18:00:00.000Z');
  });
});
