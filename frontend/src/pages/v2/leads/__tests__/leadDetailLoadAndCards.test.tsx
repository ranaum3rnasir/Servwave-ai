import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { screen, fireEvent, within } from '@testing-library/react';
import { buildAbility } from '@/lib/ability';
import { LEAD_FIXTURE } from '@/__tests__/helpers';
import { renderLeadDetail, serveLeadDetail, stubBrowser } from '@/__tests__/harness/leadDetailPage';
import { MEDIA } from '@/ui-kit/lib/breakpoints';
import { renderLeadForm } from '@/__tests__/harness/leadFormPage';

vi.mock('react-router-dom', async () => (await import('@/__tests__/harness/leadDetailRouter')).leadDetailRouter());

// Each source used to be a file of its own, so each started from the setup file's signed-in user and bare client calls.
// `clearAllMocks` keeps implementations: reset them here, so a block states its own user and answers in its own `beforeEach`.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('leadDetailLoadFailure', () => {
  /**
   * Mobile slice 68 (PRD story 140): a lead that fails to load says so and offers Retry.
   *
   * Both the detail page and the edit form rendered "Lead not found." for a failed request, so a
   * dropped connection read as "your lead is gone". A 404 still reads as not found; every other
   * failure is an error with a Retry. A 200 with no lead stays "not found" too
   * (lead-detail-page.test.tsx). The copy is fixed text: the server's own message never reaches the
   * screen.
   */

  stubBrowser();

  const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

  const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

  function serverError(status: number) {
    return { isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Supabase upstream timeout' } } };
  }

  /** The lead endpoint fails while `failing.on`; everything else answers an empty success. */
  function serve(failing: { on: boolean; status?: number }) {
    serveLeadDetail({
      lead: () => {
        if (failing.on) throw serverError(failing.status ?? 500);
        return LEAD_FIXTURE;
      },
      routes: [{ match: (url) => url !== `/api/leads/${LEAD_ID}` && url.includes('/api/leads/'), data: {} }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LeadDetailPage - a failed load is an error with Retry (slice 68)', () => {
    it('a 500 shows an error and Retry, never "Lead not found."; Retry recovers', async () => {
      const failing = { on: true };
      serve(failing);
      renderLeadDetail();

      expect(await screen.findByText("Couldn't load this lead.")).toBeInTheDocument();
      expect(screen.queryByText('Lead not found.')).toBeNull();
      expect(document.body.textContent ?? '').not.toMatch(/supabase|timeout/i);

      failing.on = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { name: /L00001\b.*John Doe/ })).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load this lead.")).toBeNull();
    });

    it('a 404 is still "Lead not found." with a way back to the list', async () => {
      serve({ on: true, status: 404 });
      renderLeadDetail();

      expect(await screen.findByText('Lead not found.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /back to leads/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
  });

  describe('LeadFormPage (edit) - a failed load is an error with Retry (slice 68)', () => {
    it('a 503 shows an error and Retry, never "Lead not found."; Retry loads the form', async () => {
      const failing = { on: true, status: 503 };
      serve(failing);
      renderLeadForm({ ability: adminAbility });

      expect(await screen.findByText("Couldn't load this lead.")).toBeInTheDocument();
      expect(screen.queryByText('Lead not found.')).toBeNull();

      failing.on = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await screen.findByDisplayValue('AC not cooling');
      expect(screen.queryByText("Couldn't load this lead.")).toBeNull();
    });
  });
});

describe('leadDetailEstimatesCards', () => {
  /**
   * Mobile slice 68 (PRD story 140, rubric CMP-01) - the lead page's Estimates tab on a phone or tablet.
   *
   * Below lg (see `useRecordCards`) each estimate is a card (one named control that opens it, the other columns as
   * labelled lines); from lg up it is the seven-column table it was. The layout is JS-chosen, so ONE
   * variant mounts. jsdom answers every media query `false` (the table).
   */

  stubBrowser();

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
    serveLeadDetail({ lead: LEAD_WITH_ESTIMATE });
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
      renderLeadDetail();
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
      renderLeadDetail();
      await openEstimatesTab();

      const panel = await screen.findByRole('tabpanel');
      expect(within(panel).getByRole('table')).toBeInTheDocument();
      expect(within(panel).queryByRole('listitem')).toBeNull();
    });
  });
});
