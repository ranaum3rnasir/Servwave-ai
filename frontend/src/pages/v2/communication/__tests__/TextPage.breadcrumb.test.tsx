/**
 * Roles & Permissions S08.17 side finding - arriving on the Phone page from a job's Text link, the trail read
 * "J00662 > comm-text > Phone": the Text page recorded itself under its menu key, and that key (a child of the
 * Communication group) names no top-level destination, so the key itself was shown as text. The page now records
 * itself as "Text", the way the Phone page records itself as "Phone".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders, communicationSectionAbility } from '@/__tests__/helpers';
import { useNavHistory } from '../../navHistory.store';
import { V2Breadcrumbs } from '../../pageBreadcrumbs';
import TextPage from '../TextPage';

vi.mock('@/lib/api/communication', () => ({ useMessageThreads: () => ({ data: [] }) }));
vi.mock('@/components/communication/phone/SmsInboxView', () => ({ SmsInboxView: () => null }));
vi.mock('@/components/communication/phone/TextingView', () => ({ TextingView: () => null }));

function crumbs() {
  return Array.from(document.querySelectorAll('[data-slot="breadcrumb-item"]')).map(
    (item) => item.textContent ?? '',
  );
}

beforeEach(() => {
  useNavHistory.getState().clear();
});

describe('the Text page breadcrumb', () => {
  it('names the page "Text" in the trail, never its internal menu key', () => {
    // The job the person came from, so the trail has more than one entry (a trail of one renders nothing).
    useNavHistory.getState().visit('/jobs/j-1', 'J00662');

    renderWithProviders(
      <>
        <V2Breadcrumbs />
        <Routes>
          <Route path="/communication/text" element={<TextPage />} />
        </Routes>
      </>,
      { initialEntries: ['/communication/text'], ability: communicationSectionAbility() },
    );

    expect(crumbs()).toEqual(['J00662', 'Text']);
  });
});
