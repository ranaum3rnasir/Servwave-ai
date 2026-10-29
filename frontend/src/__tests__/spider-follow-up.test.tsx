/**
 * Spider (#2619, Spider 8/8) - Seam E: a lead opened from a Spider alert offers a suggested
 * follow-up in its text box. Editable, capped at 500 characters, never sent without Send, and
 * offered only from a Spider alert at a company that passes the Spider gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { AbilityProvider } from '@/contexts/AbilityContext';
import { TooltipProvider as KitTooltipProvider } from '@/ui-kit/components/ui/tooltip';
import { useAuthStore } from '@/stores/auth.store';
import { LEAD_FIXTURE, NOTES_FIXTURE, renderWithProviders } from './helpers';
import { buildSpiderFollowUp, SPIDER_FOLLOW_UP_MAX_CHARS } from '@/lib/spider/followUp';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({ EntityCallDrawer: () => null }));
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({ EntitySmsDrawer: () => null }));
vi.mock('@/components/tasks/JobLeadTasksTab', () => ({ JobLeadTasksTab: () => null }));
vi.mock('react-router-dom', async () => ({
  ...(await vi.importActual<typeof import('react-router-dom')>('react-router-dom')),
  useParams: () => ({ id: 'e0000000-0000-0000-0000-000000000001' }),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mockApi = vi.mocked(api);
const admin = buildAbility([{ action: 'manage', subject: 'all' }]);
const SPIDER_USER = { id: 'u1', role: 'SALES', organization_id: 'o1', org_is_demo: true, org_features: ['leads', 'phone', 'spider'] };

function signIn(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user, isAuthenticated: true })) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  signIn(SPIDER_USER);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/notes')) return { data: { notes: NOTES_FIXTURE } };
    if (url.includes('/communications')) return { data: { items: [] } };
    if (url.includes('/api/users')) return { data: { users: [] } };
    if (url.includes('/api/leads/')) return { data: { lead: LEAD_FIXTURE } };
    if (url.includes('/api/tags')) return { data: { tags: [] } };
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: { ok: true } });
});

describe('the suggestion', () => {
  it('greets the customer by name and names the stage', () => {
    const text = buildSpiderFollowUp({ status: 'CONTACTED', customerFirstName: 'Jane', serviceRequest: 'a new door' });
    expect(text.startsWith('Hello Jane,')).toBe(true);
    expect(text).toContain('about a new door');
    expect(text).toContain('(stage: Contacted)');
  });

  it('opens with "Hello," when the customer has no name', () => {
    expect(buildSpiderFollowUp({ status: 'NEW', customerFirstName: '  ' }).startsWith('Hello, ')).toBe(true);
    expect(buildSpiderFollowUp({ status: 'NEW', customerFirstName: null }).startsWith('Hello, ')).toBe(true);
  });

  it('is cut to 500 characters', () => {
    const text = buildSpiderFollowUp({ status: 'ESTIMATED', customerFirstName: 'Jane', serviceRequest: 'x'.repeat(900) });
    expect(text).toHaveLength(SPIDER_FOLLOW_UP_MAX_CHARS);
  });
});

describe("the lead's text box", () => {
  async function renderTab(initialMessage?: string) {
    const { LeadCommunicationsTab } = await import('@/components/communication/LeadCommunicationsTab');
    return renderWithProviders(
      <LeadCommunicationsTab leadId="lead-1" leadLabel="L00001" customerId="cust-1" customerName="Jane Doe" initialMessage={initialMessage} />,
      { ability: admin },
    );
  }

  it('starts with the suggestion, which can be edited, and sends nothing until Send', async () => {
    const user = userEvent.setup();
    await renderTab('Hello Jane, checking in.');
    const box = await screen.findByRole('textbox');
    expect(box).toHaveValue('Hello Jane, checking in.');
    await user.type(box, ' Thanks!');
    expect(box).toHaveValue('Hello Jane, checking in. Thanks!');
    expect(mockApi.post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/communication/sms',
        expect.objectContaining({ body: 'Hello Jane, checking in. Thanks!' }),
      ),
    );
  });

  it('cuts an initial message longer than 500 characters', async () => {
    await renderTab('y'.repeat(800));
    expect(((await screen.findByRole('textbox')) as HTMLTextAreaElement).value).toHaveLength(500);
  });

  it('starts empty without one, as today', async () => {
    await renderTab();
    expect(await screen.findByRole('textbox')).toHaveValue('');
  });
});

describe('the lead page', () => {
  async function openLead(state?: unknown) {
    const { default: LeadDetailPage } = await import('@/pages/v2/leads/LeadDetailPage');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={qc}>
        <KitTooltipProvider delayDuration={320}>
          <MemoryRouter initialEntries={[{ pathname: '/leads/e0000000-0000-0000-0000-000000000001', state }]}>
            <AbilityProvider ability={admin}>
              <LeadDetailPage />
            </AbilityProvider>
          </MemoryRouter>
        </KitTooltipProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: /Communication/ }));
    return screen.findByRole('textbox', {}, { timeout: 10_000 });
  }

  it('pre-fills the suggestion when the lead was opened from a Spider alert', async () => {
    const box = await openLead({ spiderFollowUp: true });
    const first = (LEAD_FIXTURE as { customer?: { first_name?: string } }).customer?.first_name;
    expect((box as HTMLTextAreaElement).value).toBe(
      buildSpiderFollowUp({ status: LEAD_FIXTURE.status, customerFirstName: first, serviceRequest: LEAD_FIXTURE.service_request }),
    );
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('pre-fills nothing when the lead was opened any other way', async () => {
    const box = await openLead();
    expect(box).toHaveValue('');
  });

  it('pre-fills nothing at a company without Spider, even from an alert link', async () => {
    signIn({ ...SPIDER_USER, org_is_demo: false });
    const box = await openLead({ spiderFollowUp: true });
    expect(box).toHaveValue('');
  });
});
