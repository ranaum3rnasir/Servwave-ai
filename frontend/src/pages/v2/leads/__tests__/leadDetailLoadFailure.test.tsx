import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';

import LeadDetailPage from '../LeadDetailPage';
import LeadFormPage from '../LeadFormPage';

/**
 * Mobile slice 68 (PRD story 140): a lead that fails to load says so and offers Retry.
 *
 * Both the detail page and the edit form rendered "Lead not found." for a failed request, so a
 * dropped connection read as "your lead is gone". A 404 still reads as not found; every other
 * failure is an error with a Retry. A 200 with no lead stays "not found" too
 * (lead-detail-page.test.tsx). The copy is fixed text: the server's own message never reaches the
 * screen.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }) };
});

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function serverError(status: number) {
  return { isAxiosError: true, message: 'Request failed', response: { status, data: { error: 'Supabase upstream timeout' } } };
}

/** The lead endpoint fails while `failing.on`; everything else answers an empty success. */
function serve(failing: { on: boolean; status?: number }) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === `/api/leads/${LEAD_ID}`) {
      if (failing.on) throw serverError(failing.status ?? 500);
      return { data: { lead: LEAD_FIXTURE } };
    }
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LeadDetailPage - a failed load is an error with Retry (slice 68)', () => {
  it('a 500 shows an error and Retry, never "Lead not found."; Retry recovers', async () => {
    const failing = { on: true };
    serve(failing);
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

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
    renderWithProviders(<LeadDetailPage />, { ability: adminAbility });

    expect(await screen.findByText('Lead not found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /back to leads/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('LeadFormPage (edit) - a failed load is an error with Retry (slice 68)', () => {
  it('a 503 shows an error and Retry, never "Lead not found."; Retry loads the form', async () => {
    const failing = { on: true, status: 503 };
    serve(failing);
    renderWithProviders(<LeadFormPage />, { ability: adminAbility });

    expect(await screen.findByText("Couldn't load this lead.")).toBeInTheDocument();
    expect(screen.queryByText('Lead not found.')).toBeNull();

    failing.on = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByDisplayValue('AC not cooling');
    expect(screen.queryByText("Couldn't load this lead.")).toBeNull();
  });
});
