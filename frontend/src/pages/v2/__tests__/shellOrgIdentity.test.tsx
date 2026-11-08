/// <reference types="@testing-library/jest-dom/vitest" />
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { buildAbility } from '@/lib/ability';
import type { Organization } from '@/lib/api/organization';
import { useOrganization } from '@/lib/api/organization';

import V2AppLayout from '../V2AppLayout';

/**
 * The v2 topbar must carry the SAME organisation identity the legacy header
 * carries, because it is the only place either shell says which organisation
 * you are signed in to.
 *
 * `components/layout/Header.tsx` renders two things this asserts:
 *
 *   - the org's name as the bar's title (`const title = org?.name ?? ''`), and
 *   - the org's logo as the account avatar's image, with
 *     `alt={org?.name ? `${org.name} logo` : 'Company logo'}` and the signed-in
 *     user's initials as the fallback when there is no logo.
 *
 * The first v2 shell shipped neither: its bar showed the "ServWave" wordmark
 * and an initials chip, and nothing else. Both losses are invisible to a code
 * review - you only see them with the two shells side by side - so they are
 * pinned here.
 */

// The shell mounts a copilot, an AI modal, a dialer, a notification bell, a
// search box and a geofenced clock. None of them is what this file is about,
// and each drags in a realtime subscription or a query of its own, so they are
// stubbed down to nothing.
vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => ({ sms: 0, whatsapp: 0, email: 0 }),
}));

// The one query this file does care about.
vi.mock('@/lib/api/organization', () => ({ useOrganization: vi.fn() }));

const ORG = {
  id: 'org-1',
  name: 'Copperline Home Services',
  logo_url: 'https://cdn.example.test/copperline.png',
  currency: 'USD',
  date_format: 'MM/DD/YYYY',
} as unknown as Organization;

function mockOrg(org: Partial<Organization> | undefined) {
  vi.mocked(useOrganization).mockReturnValue({
    data: org,
  } as ReturnType<typeof useOrganization>);
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <AbilityProvider ability={buildAbility([{ action: 'manage', subject: 'all' }])}>
          <Routes>
            <Route element={<V2AppLayout />}>
              <Route path="/" element={<div>page</div>} />
            </Route>
          </Routes>
        </AbilityProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('v2 shell - organisation identity in the topbar', () => {
  beforeEach(() => {
    localStorage.clear();
    mockOrg(ORG);
  });

  it('names the organisation the user is signed in to', () => {
    renderShell();
    expect(screen.getByText('Copperline Home Services')).toBeInTheDocument();
  });

  it("renders the org's logo, with the legacy header's alt text", () => {
    renderShell();
    const logo = screen.getByAltText('Copperline Home Services logo');
    expect(logo).toHaveAttribute('src', ORG.logo_url);
  });

  it('falls back to "Company logo" when the org has a logo but no name', () => {
    mockOrg({ ...ORG, name: '' });
    renderShell();
    expect(screen.getByAltText('Company logo')).toBeInTheDocument();
  });

  it('falls back to the user initials when the org has no logo, exactly as legacy does', () => {
    mockOrg({ ...ORG, logo_url: null });
    renderShell();
    expect(screen.queryByRole('img', { name: /logo/i })).toBeNull();
    // setup.ts signs in "Test Admin".
    expect(screen.getByText('TA')).toBeInTheDocument();
  });

  it('renders no organisation name at all when the org has not loaded', () => {
    mockOrg(undefined);
    renderShell();
    expect(screen.queryByText('Copperline Home Services')).toBeNull();
  });
});
