/**
 * #2091 — on `/estimates/<id>/versions/1` (the read-only past-version page, #2030), the trail's
 * last crumb read "Estimates" instead of naming the page, because the page never called
 * `useRecordVisit` and the layout's own fallback (`fallbackLabelFor`) named it after the first URL
 * segment. Fixed by recording a visit the same way `EstimateWorkspacePage.tsx` does — same nav key
 * ('estimates'), so both read as one journey in the trail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import { useNavHistory } from '../../navHistory.store';
import { V2Breadcrumbs } from '../../pageBreadcrumbs';
import EstimateVersionPage from '../EstimateVersionPage';

const ESTIMATE_ID = 'est-1';

const VERSION = {
  version: 1,
  trigger: 'SEND',
  sent_at: '2026-02-01T12:00:00Z',
  estimate_id: ESTIMATE_ID,
  estimate_number: 'EST-1042',
  document: {
    view: { number: 'EST-1042', taxRate: 0, scopeNotes: null, rows: [], hasLineItems: false, hasScopes: false, totals: [] },
    customer: null,
  },
};

function crumbs() {
  return Array.from(document.querySelectorAll('[data-slot="breadcrumb-item"]')).map(
    (item) => item.textContent ?? '',
  );
}

beforeEach(() => {
  useNavHistory.getState().clear();
  vi.clearAllMocks();
});

function open() {
  // A prior page in the trail, so V2Breadcrumbs renders at all — a trail of one renders nothing
  // (see `pageBreadcrumbs.tsx`), which would hide the very bug this test exists to catch.
  useNavHistory.getState().visit('/estimates', 'Estimates');

  return renderWithProviders(
    <>
      <V2Breadcrumbs />
      <Routes>
        <Route path="/estimates/:id/versions/:version" element={<EstimateVersionPage />} />
      </Routes>
    </>,
    { initialEntries: [`/estimates/${ESTIMATE_ID}/versions/1`] },
  );
}

describe('the version page breadcrumb', () => {
  it('names itself after the estimate and version once it loads, not "Estimates"', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { version: VERSION } } as never);
    open();

    await screen.findByText('EST-1042 · Version 1');
    expect(crumbs()).toEqual(['Estimates', 'EST-1042 · Version 1']);
    expect(screen.queryByText('Estimates', { selector: '[data-slot="breadcrumb-page"]' })).not.toBeInTheDocument();
  });
});
