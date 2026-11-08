// Regression: an account with more than one page of numbers is stored in full.
//
// The phone system pages its number list 10 at a time and gives `next_page` as
// a URL, not a page number. A walk that read it as a number stopped after page
// one, and ServWave stored only the first page while the account held more.
// This runs the REAL client against a stubbed fetch, so the paging walk itself
// is under test, not a mock that hands back a ready-made array.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.unmock('../client');

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_ACCESS_KEY: 'test-access-key',
    CTM_SECRET_KEY: 'test-secret-key',
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../../../config/env', () => mockEnv);

import { prisma } from '../../prisma';
import { syncNumbers } from '../numberSync';
import { installPhoneNumberStore } from './phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const ACCOUNT = '500001';
const PAGE_SIZE = 10;
const TOTAL = 30;

const numberAt = (i: number) => ({
  id: `TPN-${i}`,
  number: `+1609555${String(1000 + i)}`,
  name: null,
  type: 'local',
  status: 'active',
  sms_enabled: true,
  route_to: { type: 'receiving_number', dial: [] },
});

function pageResponse(page: number) {
  const totalPages = TOTAL / PAGE_SIZE;
  const items = Array.from({ length: PAGE_SIZE }, (_, k) => numberAt((page - 1) * PAGE_SIZE + k));
  return new Response(
    JSON.stringify({
      page,
      total_pages: totalPages,
      total_entries: TOTAL,
      next_page:
        page < totalPages
          ? `https://api.calltrackingmetrics.com/api/v1/accounts/${ACCOUNT}/numbers?page=${page + 1}`
          : null,
      numbers: items,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  p.auditLog.create.mockResolvedValue({});
  // The org is on the account being synced (a run re-reads it after the list).
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return pageResponse(page);
  });
});

describe('syncNumbers - an account with several pages of numbers', () => {
  it('reads and stores every page, not just the first', async () => {
    const store = installPhoneNumberStore();

    const result = await syncNumbers({ orgId: 'org-1', accountId: ACCOUNT, trigger: 'manual' });

    expect(result.read).toBe(TOTAL);
    expect(store.rows).toHaveLength(TOTAL);
    expect(store.get(numberAt(TOTAL - 1).number)).toBeDefined();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
