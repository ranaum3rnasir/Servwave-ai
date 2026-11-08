// Scheduling a walkthrough on the v2 lead page uses the SAME four fields as scheduling a
// job - start date, start time, end date, end time - and writes them against the ORG's
// timezone, not the browser's. Before this the tab paired one combined
// 'YYYY-MM-DDTHH:MM' picker with a Duration dropdown and posted
// `new Date(value).toISOString()`, so it described one act of scheduling differently from
// every other surface and resolved the wall clock against whatever zone the dispatcher's
// laptop was in.
//
// This file began as a mirror of `src/__tests__/lead-detail-walkthrough-schedule.test.tsx`, which
// held the first two cases below against the unrouted v1 lead page. That page and that file are
// both deleted, so these are now the only copy - the third case (a start in the org zone plus a
// duration derived from the two ends) was never in the legacy spec and is why the mirror was a
// superset rather than a duplicate.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders, LEAD_FIXTURE } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import LeadDetailPage from '../LeadDetailPage';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => false,
}));

vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('@/components/communication/LeadCommunicationsTab', () => ({ LeadCommunicationsTab: () => null }));

// The real picker fetches the assignable roster; this test is about the time fields.
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['user-1'])}>performers:{value.join(',') || 'none'}</button>
  ),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: [] } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    if (url.includes('/api/leads/')) {
      return {
        data: {
          lead: {
            ...LEAD_FIXTURE,
            status: 'CONTACTED',
            walkthrough_scheduled_at: null,
            walkthrough_completed_at: null,
            walkthrough_cancelled_at: null,
          },
        },
      };
    }
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: {} });
});

/** Opens the walkthrough tab and returns its [start date, start time, end date, end time]. */
async function openWalkthroughFields(user: ReturnType<typeof userEvent.setup>) {
  renderWithProviders(<LeadDetailPage />, { ability: adminAbility });
  await user.click(await screen.findByRole('tab', { name: /walkthrough/i }));
  return () => screen.getAllByRole('textbox').filter(
    (el) => (el as HTMLInputElement).placeholder === 'MM/DD/YYYY' || (el as HTMLInputElement).placeholder === 'Time',
  ) as HTMLInputElement[];
}

describe('v2 LeadDetailPage - scheduling a walkthrough', () => {
  it('asks the same four questions as every other scheduling surface', async () => {
    const user = userEvent.setup();
    await openWalkthroughFields(user);

    expect(screen.getByLabelText('Start date')).toBeInTheDocument();
    expect(screen.getByLabelText('Start time')).toBeInTheDocument();
    expect(screen.getByLabelText('End date')).toBeInTheDocument();
    expect(screen.getByLabelText('End time')).toBeInTheDocument();
    expect(screen.queryByLabelText('Duration')).not.toBeInTheDocument();
  });

  it('keeps the date after picking it, before any time is set', async () => {
    const user = userEvent.setup();
    const fields = await openWalkthroughFields(user);

    await user.type(fields()[0]!, '09/01/2026');
    await user.tab();

    // The END date, not the one typed into: an input holds its own display text either
    // way, so only an untouched field proves the PAGE kept the date.
    expect(fields()[2]!.value).toBe('09/01/2026');
  });

  it('posts the start in the ORG zone and the duration derived from the two ends', async () => {
    const user = userEvent.setup();
    const fields = await openWalkthroughFields(user);

    await user.click(screen.getByText(/^performers:/));
    await user.type(fields()[0]!, '09/01/2026');
    await user.tab();
    await user.type(fields()[1]!, '9:00 AM');
    await user.tab();
    await user.type(fields()[3]!, '11:30 AM');
    await user.tab();

    const button = screen.getByRole('button', { name: /Schedule Walkthrough/ });
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    const call = mockApi.post.mock.calls.find(([url]) => String(url).includes('/walkthrough/schedule'));
    const payload = call?.[1] as Record<string, unknown>;
    // Org zone defaults to America/New_York; 9:00 AM EDT on 2026-09-01 is 13:00Z.
    expect(payload.walkthrough_scheduled_at).toBe('2026-09-01T13:00:00.000Z');
    expect(payload.walkthrough_duration_minutes).toBe(150);
    expect(payload.performer_ids).toEqual(['user-1']);
  });
});
