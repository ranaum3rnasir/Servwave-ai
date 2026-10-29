/// <reference types="@testing-library/jest-dom/vitest" />
// #2046 - the /communication/* route guard. `RequireCommunicationSection` gates the org-wide
// Communication SECTION (the sidebar group's own pages) on `access_inbox Communication`, never a
// role list, and its PLACEMENT relative to the app shell is itself part of the fix (R10): sitting
// it OUTSIDE `V2AppLayout` is what stops a denied deep link from mounting the shell, or firing a
// single /api/communication/* request. `repro-2046.test.tsx` could not pin this - it documents the
// guard as `<ProtectedRoute allowedRoles={[...]}>`, a role list with no ability parameter at all -
// so this is the surface that test's own trailing comment left to the fix stage.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import api from '@/lib/axios';
import {
  renderWithProviders,
  communicationSectionAbility,
  readOnlyCommunicationAbility,
} from './helpers';
import RequireCommunicationSection from '@/components/RequireCommunicationSection';
import { communicationV2Routes } from '@/pages/v2/routes/communication.routes';
import { useAuthStore } from '@/stores/auth.store';
import V2AppLayout from '@/pages/v2/V2AppLayout';

// The mutation-proof block below mounts the REAL V2AppLayout, so it needs the same seam mocks
// `sidebarNavGroups.test.tsx` / `shellCustomizeSidebar.test.tsx` use for everything the shell
// pulls in that is not the destination list.
vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/communication/phone/Dialer', () => ({ GlobalDialer: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
// A spy, not an inert stub: `V2AppLayout` calls `useUnreadCounts()` unconditionally at the top of
// its body, so whether this fired is a cheap, comms-unrelated proxy for "did the SHELL's own
// function body run" - the thing R10's placement rule decides, independent of whether the guard
// itself correctly blocked the PAGE underneath it (which it always does, in both arrangements).
const useUnreadCountsMock = vi.hoisted(() => vi.fn(() => ({ sms: 0, whatsapp: 0, email: 0 })));
vi.mock('@/lib/api/communication', () => ({ useUnreadCounts: useUnreadCountsMock }));
vi.mock('@/lib/api/organization', () => ({ useOrganization: () => ({ data: undefined }) }));

const mockApi = vi.mocked(api);

// The real `communicationV2Routes()` starts with a bare, auth-only `<ProtectedRoute />`, which
// (unlike every other consumer in this codebase) calls `useAuthStore()` with NO selector. The
// global setup.ts mock only supports the selector form - override it here, once, so the AC6 test
// below can exercise the real routed tree rather than a hand-trimmed copy of it.
vi.mocked(useAuthStore).mockImplementation(((selector?: (s: Record<string, unknown>) => unknown) => {
  const state = {
    user: { id: '00000000-0000-0000-0000-000000000001', role: 'SALES' },
    isAuthenticated: true,
    isLoading: false,
    error: null,
  };
  return selector ? selector(state) : state;
}) as typeof useAuthStore);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequireCommunicationSection', () => {
  it('redirects to the app home without the section ability, mounting no protected content', () => {
    renderWithProviders(
      <Routes>
        <Route element={<RequireCommunicationSection />}>
          <Route path="/x" element={<div>protected content</div>} />
        </Route>
        <Route path="/" element={<div>app home</div>} />
      </Routes>,
      { initialEntries: ['/x'], ability: readOnlyCommunicationAbility() },
    );

    expect(screen.getByText('app home')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('renders the outlet for an ability holding the section gate', () => {
    renderWithProviders(
      <Routes>
        <Route element={<RequireCommunicationSection />}>
          <Route path="/x" element={<div>protected content</div>} />
        </Route>
        <Route path="/" element={<div>app home</div>} />
      </Routes>,
      { initialEntries: ['/x'], ability: communicationSectionAbility() },
    );

    expect(screen.getByText('protected content')).toBeInTheDocument();
  });
});

// AC6 - a denied deep link into /communication/* fetches nothing. Uses the REAL routed tree
// (`communicationV2Routes`), not a stand-in: with the section ability absent,
// `RequireCommunicationSection` redirects BEFORE `V2AppLayout` - and therefore before the lazy
// `TextPage` chunk, and every hook it and its children own - ever mounts, so there is nothing left
// to fire a request. `readOnlyCommunicationAbility()` is the exact shape the reproducer pins for
// SALES (`read`/`create Communication`, no `access_inbox`).
describe('#2046 AC6 - a denied deep link fetches nothing', () => {
  it('as a read-only-Communication (SALES-shaped) ability, /communication/text lands on the app home with zero /api/communication/* calls', () => {
    renderWithProviders(
      <Routes>
        {communicationV2Routes()}
        <Route path="/" element={<div>app home</div>} />
      </Routes>,
      { initialEntries: ['/communication/text'], ability: readOnlyCommunicationAbility() },
    );

    expect(screen.getByText('app home')).toBeInTheDocument();
    const commCalls = mockApi.get.mock.calls.filter(([url]) =>
      String(url).startsWith('/api/communication/'),
    );
    expect(commCalls).toHaveLength(0);
  });
});

// Mutation proof for R10's placement claim: the guard has to sit OUTSIDE `V2AppLayout`, not merely
// exist. `ServWave home` (the shell's brand link) is a cheap, comms-unrelated marker of the SHELL
// runs at all - a client-side `<Navigate>` re-matches the WHOLE `<Routes>` tree against the new
// URL, so once the redirect's effect flushes (React Testing Library's `render` flushes effects
// synchronously), a denied deep link settles on "app home" either way, with the page blocked in
// both arrangements. `useUnreadCountsMock` is what actually distinguishes them: it is the first
// hook `V2AppLayout`'s body calls, so whether it ran is a direct read on whether the shell's own
// function body EXECUTED (and therefore whether the OTHER, ungated hooks a real page under it
// owns would also have executed) before the redirect took over - independent of what the settled
// DOM shows. Both trees use the REAL `RequireCommunicationSection` and the REAL `V2AppLayout`;
// only their relative order changes.
describe('#2046 R10 - the guard placement (outside V2AppLayout), not just its existence, is load-bearing', () => {
  it('placed OUTSIDE V2AppLayout (the real arrangement): a denied ability never runs the shell body', () => {
    renderWithProviders(
      <Routes>
        <Route element={<RequireCommunicationSection />}>
          <Route element={<V2AppLayout />}>
            <Route path="/communication/text" element={<div>leaf</div>} />
          </Route>
        </Route>
        <Route path="/" element={<div>app home</div>} />
      </Routes>,
      { initialEntries: ['/communication/text'], ability: readOnlyCommunicationAbility() },
    );

    expect(screen.getByText('app home')).toBeInTheDocument();
    expect(screen.queryByText('leaf')).not.toBeInTheDocument();
    expect(useUnreadCountsMock).not.toHaveBeenCalled();
  });

  it('placed INSIDE V2AppLayout (the wrong arrangement): a denied ability still runs the shell body', () => {
    renderWithProviders(
      <Routes>
        <Route element={<V2AppLayout />}>
          <Route element={<RequireCommunicationSection />}>
            <Route path="/communication/text" element={<div>leaf</div>} />
          </Route>
        </Route>
        <Route path="/" element={<div>app home</div>} />
      </Routes>,
      { initialEntries: ['/communication/text'], ability: readOnlyCommunicationAbility() },
    );

    // The page itself is still correctly blocked...
    expect(screen.queryByText('leaf')).not.toBeInTheDocument();
    // ...but `V2AppLayout`'s own body ran anyway (and with it every hook a real page under it
    // owns that is NOT itself ability-gated) - this is exactly what R10's placement rule prevents
    // in the real route table.
    expect(useUnreadCountsMock).toHaveBeenCalled();
  });
});
