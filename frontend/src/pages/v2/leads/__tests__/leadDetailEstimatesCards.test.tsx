import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';

import LeadDetailPage from '../LeadDetailPage';

/**
 * Mobile slice 68 (PRD story 140, rubric CMP-01) - the lead page's Estimates tab on a phone or tablet.
 *
 * Below lg (see `useRecordCards`) each estimate is a card (one named control that opens it, the other columns as
 * labelled lines); from lg up it is the seven-column table it was. The layout is JS-chosen, so ONE
 * variant mounts. jsdom answers every media query `false` (the table).
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

const LEAD_WITH_ESTIMATE = {
  ...LEAD_FIXTURE,
  estimates: [{
    id: 'est-1', estimate_number: 'EST-2001', status: 'SENT', total_amount: '480.00',
    created_at: '2026-02-01T12:00:00.000Z',
    creator: { id: 'u1', first_name: 'Ana', last_name: 'Lee' },
    deposit: null,
  }],
};

const originalMatchMedia = window.matchMedia;
function answerMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/api/leads/')) return { data: { lead: LEAD_WITH_ESTIMATE } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

async function openEstimatesTab() {
  fireEvent.click(await screen.findByRole('tab', { name: /Estimates \(1\)/ }));
}

describe('LeadDetailPage - Estimates tab as cards (slice 68)', () => {
  it('below lg: a card per estimate, no table, and the card opens the estimate', async () => {
    answerMedia((q) => q === MEDIA.belowLg);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await openEstimatesTab();

    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).queryByRole('table')).toBeNull();
    const open = within(panel).getByRole('button', { name: 'EST-2001' });
    const card = open.closest('li')!;
    expect(within(card).getByText('$480.00')).toBeInTheDocument();
    expect(within(card).getByText('Created By')).toBeInTheDocument();
    expect(within(card).getByText('Ana Lee')).toBeInTheDocument();
  });

  it('from lg up: the table it was, and no cards', async () => {
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
    await openEstimatesTab();

    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByRole('table')).toBeInTheDocument();
    expect(within(panel).queryByRole('listitem')).toBeNull();
  });
});
