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
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AbilityProvider } from '@/contexts/AbilityContext';
import { communicationSectionAbility, readOnlyCommunicationAbility, seedMySwitches } from '@/__tests__/helpers';
import { catalogToggle } from '@/__tests__/support/backendSwitchCatalog';
import { useAuthStore } from '@/stores/auth.store';

import V2AppLayout from '../V2AppLayout';

vi.mock('@/components/copilot/CopilotProvider', () => ({ default: () => null }));
vi.mock('@/components/ai-center/AiCenterModal', () => ({ AiCenterModal: () => null }));
vi.mock('@/components/notifications/NotificationBell', () => ({ NotificationBell: () => null }));
vi.mock('@/components/layout/GlobalSearch', () => ({ default: () => null }));
vi.mock('@/components/timeclock/ClockInOutMenu', () => ({ ClockInOutMenu: () => null }));
// The counts are the server's (it counts only the conversations in the person's scope); the shell draws what it is told.
const unread = vi.hoisted(() => ({ sms: 0, whatsapp: 0, email: 0 }));
vi.mock('@/lib/api/communication', () => ({
  useUnreadCounts: () => unread,
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
              <Route path="/communication/text" element={<div>text page</div>} />
              <Route path="/communication/phone" element={<div>phone page</div>} />
              <Route path="/communication/inbox" element={<div>inbox page</div>} />
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
    Object.assign(unread, { sms: 0, whatsapp: 0, email: 0 });
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

  it('shows Text messages / Inbox for an ability holding the section gate and the Show switches', () => {
    seedMySwitches(shown(), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.getByRole('button', { name: 'Text messages' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inbox' })).toBeInTheDocument();
  });
});

// Roles & Permissions S08.17 - the two shortcuts follow Show Text and Show Email, keeping the plan check and the section
// gate. The person's switches come from the "me" answer (cached here, as the sidebar tests do); the section ability is
// held in every case, so the Show switch is the only thing that differs.
const SHOW_TEXT = catalogToggle('Show Text').key;
const SHOW_EMAIL = catalogToggle('Show Email').key;
const SHOW_PHONE = catalogToggle('Show Phone').key;

/** Every Communication Show switch on, then the given overrides. */
function shown(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return { [SHOW_PHONE]: true, [SHOW_TEXT]: true, [SHOW_EMAIL]: true, ...overrides };
}

describe('V2AppLayout - S08.17 comms shortcuts follow Show Text and Show Email', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(unread, { sms: 4, whatsapp: 0, email: 7 });
    mockAuthUser({
      id: USER_ID,
      email: 'person@test.com',
      first_name: 'Test',
      last_name: 'Person',
      role: 'DISPATCHER',
      org_features: ['phone', 'email'],
    });
  });

  it('shows both shortcuts with their unread badges when Show Text and Show Email are on', () => {
    seedMySwitches(shown(), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.getByRole('button', { name: 'Text messages' })).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveTextContent('7');
  });

  it('hides Text messages and its badge with Show Text off, even with Show Phone on, and keeps Inbox', () => {
    seedMySwitches(shown({ [SHOW_TEXT]: false }), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Inbox' })).toHaveTextContent('7');
    expect(screen.queryByText('4')).toBeNull();
  });

  it('hides Inbox and its badge with Show Email off, and keeps Text messages', () => {
    seedMySwitches(shown({ [SHOW_EMAIL]: false }), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Text messages' })).toHaveTextContent('4');
    expect(screen.queryByText('7')).toBeNull();
  });

  it('opens the Text page from Text messages, not the Phone page', async () => {
    seedMySwitches(shown(), USER_ID);
    renderShell(communicationSectionAbility());

    await userEvent.click(screen.getByRole('button', { name: 'Text messages' }));

    expect(await screen.findByText('text page')).toBeInTheDocument();
    expect(screen.queryByText('phone page')).toBeNull();
  });

  it('opens the inbox from Inbox', async () => {
    seedMySwitches(shown(), USER_ID);
    renderShell(communicationSectionAbility());

    await userEvent.click(screen.getByRole('button', { name: 'Inbox' }));

    expect(await screen.findByText('inbox page')).toBeInTheDocument();
  });

  it('draws neither shortcut before the person\'s switches have arrived', () => {
    renderShell(communicationSectionAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
  });

  it('keeps the section gate on top of the Show switches', () => {
    seedMySwitches(shown(), USER_ID);
    renderShell(readOnlyCommunicationAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
  });

  it('keeps the dialer for a person with both Show switches off', () => {
    seedMySwitches(shown({ [SHOW_TEXT]: false, [SHOW_EMAIL]: false, [SHOW_PHONE]: false }), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
    expect(screen.getByRole('button', { name: /open dialer/i })).toBeInTheDocument();
  });

  it('keeps the plan check on top of the Show switches', () => {
    mockAuthUser({
      id: USER_ID,
      email: 'person@test.com',
      first_name: 'Test',
      last_name: 'Person',
      role: 'DISPATCHER',
      org_features: [],
    });
    seedMySwitches(shown(), USER_ID);
    renderShell(communicationSectionAbility());

    expect(screen.queryByRole('button', { name: 'Text messages' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Inbox' })).toBeNull();
  });
});
