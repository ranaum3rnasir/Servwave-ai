/// <reference types="@testing-library/jest-dom/vitest" />
// #2046 - the v2 shell's OWN comms shortcuts. `V2AppLayout` (not `components/layout/Header.tsx`,
// which is dead code behind the retired v1 `AppLayout` - `App.tsx` routes everything through
// `v2Routes()` now) is the actual top bar every SALES rep sees on every page. Its "Text messages"
// / "Inbox" `TopBarAction`s used to key on the `phone`/`email` entitlement alone, so they jumped
// straight into the now-gated `/communication/*` section for a caller who lacks
// `access_inbox Communication` - same class of defect Header.tsx's kebab had, on the surface that
// is actually live. `<GlobalDialer />` is the control: it stays on the entitlement alone (click-to-call is not
// a jump into the section), so it is deliberately left real here rather than mocked away.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility, readOnlyCommunicationAbility } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const USER_ID = '00000000-0000-0000-0000-000000000001';

function mockAuthUser(user: Record<string, unknown>) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: never) => unknown) =>
    selector({ user, isAuthenticated: true, isLoading: false, error: null } as never),
  );
}

function renderShell(ability: ReturnType<typeof communicationSectionAbility>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={ability}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>dashboard page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('V2AppLayout - #2046 comms shortcuts', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAuthUser({
      id: USER_ID,
      email: 'sales@test.com',
      first_name: 'Test',
      last_name: 'Sales',
      role: 'SALES',
      org_features: ['phone', 'email'],
    });
  });

  it('hides Text messages / Inbox for a read-only-Communication ability, keeping the dialer', () => {
    renderShell(readOnlyCommunicationAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
    expect(screen.getByRole('button', { name: /open dialer/i })).toBeInTheDocument();
  });

  it('shows Text messages / Inbox for an ability holding the section gate', () => {
    renderShell(communicationSectionAbility());

    expect(screen.getByRole('button', { name: 'Text messages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
  });
});
