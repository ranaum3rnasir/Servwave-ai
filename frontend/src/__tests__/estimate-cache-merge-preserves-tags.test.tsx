/**
 * SRVW-103 - the estimate workspace hydrates `tags` from GET /api/estimates/:id, but every
 * granular line/scope/discount/cost mutation responds with an estimateDetailSelect payload that
 * carries NO tags key. Those responses are written straight into the SAME ['estimate', id] cache
 * entry the page reads, so a wholesale replace erases the chip until remount.
 *
 * Two halves:
 *  - behavioural, proving the merge SEMANTICS at runtime on one real trigger;
 *  - a source guard, proving EVERY ['estimate', ...] cache write in the estimate components is a
 *    merge updater (LineItemsTable exposes no stable per-row aria-label, so the ten line/scope
 *    call sites cannot be driven cheaply through the DOM).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWithProviders } from './helpers';
import { EstimateReceiptCard, type EstimateReceiptCardEstimate } from '@/components/estimates/EstimateReceiptCard';
import * as estimatesApi from '@/lib/api/estimates';

vi.mock('@/lib/api/estimates', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/estimates')>('@/lib/api/estimates');
  return { ...actual, updateEstimate: vi.fn() };
});

vi.mock('@/lib/api/invoices', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/invoices')>('@/lib/api/invoices');
  return { ...actual, fetchStateTaxRates: vi.fn().mockResolvedValue([]) };
});

const TAGS = [{ id: 't1', name: 'Recurring billing', color: '#2F7D5D' }];

function estimate(overrides: Partial<EstimateReceiptCardEstimate> = {}): EstimateReceiptCardEstimate {
  return {
    id: 'est-1',
    subtotal: 1000,
    discount_amount: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    tax_rate: 0,
    tax_amount: 0,
    total_amount: 1000,
    deposit_type: null,
    deposit_value: null,
    send_config: null,
    line_items: [],
    scopes: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Stands in for EstimateWorkspacePage's own `useQuery(['estimate', id])`. Without a live observer
 * the test client's `gcTime: 0` evicts a bare `setQueryData` seed on the next tick, so this is what
 * keeps the entry alive - and it seeds it with the same GET-hydrated shape (tags included) the real
 * page holds.
 */
function EstimateCacheProbe() {
  useQuery({
    queryKey: ['estimate', 'est-1'],
    queryFn: async () => ({ id: 'est-1', subtotal: 1000, tags: TAGS }),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return null;
}

describe('estimate cache writes preserve hydrated tags', () => {
  it('an estimate mutation preserves tags already in the [estimate, id] cache', async () => {
    const user = userEvent.setup();
    // Exactly what the real backend returns from PATCH /api/estimates/:id - no tags key.
    vi.mocked(estimatesApi.updateEstimate).mockResolvedValue({
      estimate: { id: 'est-1', subtotal: 1000, discount_type: 'PERCENTAGE' },
    } as never);

    const { queryClient } = renderWithProviders(
      <>
        <EstimateCacheProbe />
        <EstimateReceiptCard
          estimate={estimate({ discount_type: 'FIXED_AMOUNT', discount_value: 50, discount_amount: 50 })}
          canEditNow
        />
      </>,
    );

    // The detail read lands first, exactly as it does on the real page.
    await waitFor(() => {
      expect((queryClient.getQueryData(['estimate', 'est-1']) as Record<string, unknown>)?.tags).toEqual(TAGS);
    });

    await user.click(screen.getByRole('button', { name: 'Discount as a percentage' }));

    await waitFor(() => {
      const cached = queryClient.getQueryData(['estimate', 'est-1']) as Record<string, unknown>;
      // The merge took the new value...
      expect(cached.discount_type).toBe('PERCENTAGE');
      // ...without dropping the read-only field only GET /:id hydrates.
      expect(cached.tags).toEqual(TAGS);
    });
  });

  it('every setQueryData([estimate, ...]) in the estimate components is a merge updater', () => {
    const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = [
      'components/estimates/EstimateLineItemsEditor.tsx',
      'components/estimates/EstimateReceiptCard.tsx',
      'components/estimates/EstimateInternalCostsCard.tsx',
    ];

    // Each ['estimate', <id>] cache write must be followed by an `(old) => ...` updater, never a
    // positional payload. The call-site COUNT is asserted too, so a newly-added wholesale write
    // reddens this test rather than slipping past the shape check.
    // The optional generic group is lazy so it spans a NESTED generic argument
    // (`setQueryData<Record<string, unknown>>`), not just the first `>`.
    const callSite = /setQueryData(?:<[^(]*?>)?\(\s*\['estimate',[^\]]*\],\s*([\s\S]{0,40})/g;
    // EstimateLineItemsEditor's docblock describes this very cache write in prose, so comments
    // are stripped first - otherwise documentation counts as a call site.
    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const sites: Array<{ file: string; tail: string }> = [];
    for (const rel of files) {
      const src = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      for (const m of src.matchAll(callSite)) sites.push({ file: rel, tail: m[1]! });
    }

    expect(sites).toHaveLength(4);
    const wholesale = sites.filter((s) => !/\(\s*old\s*\)\s*=>/.test(s.tail));
    expect(wholesale.map((s) => `${s.file}: ${s.tail.trim()}`)).toEqual([]);
  });
});
