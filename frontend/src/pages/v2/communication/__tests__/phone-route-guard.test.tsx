/// <reference types="@testing-library/jest-dom/vitest" />
// Task A3 — the dedicated `/phone` tab (sole CTM device-owner surface) is
// gated on BOTH the org-level Communication access flag
// (useFeature('phone') — the org's plan entitlement) AND the
// user-level CASL grant (ability.can('create', 'Communication')) — never a
// hardcoded role list (master plan Global Constraints). A user failing
// EITHER check must never reach the shell; only a user passing both does.
// The page itself (the actual softphone UI + CTM device boot) is mocked out
// here - this file tests the ROUTE GUARD, not the page's internals (covered
// separately by the Softphone/useCtmSoftphone suites).
//
// Retargeted at `pages/v2/communication/PhoneTabPage` when the legacy
// `pages/phone/PhonePage` + `PhoneShell` pair was deleted as unroutable.
// `pages/v2/routes/communication.routes.tsx` mounts PhoneTabPage at `/phone`
// behind this same RequireCommunicationCreate, and PhoneTabPage's docblock
// records that the handoff, the window.name untainting and the caller-ID seed
// were carried across from PhoneShell line for line.
//
// This is the ONLY behavioural test of RequireCommunicationCreate in the repo.
// `pages/v2/__tests__/guardStacks.test.ts` pins that `/phone` is DECLARED with
// this guard, by parsing the route files as text; it never renders, so it
// cannot catch a guard that is declared and then fails to redirect. The two are
// complements, which is why this file was retargeted rather than folded into
// that pin.
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility, emptyAbility, type AppAbility } from '@/lib/ability';

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: vi.fn(),
}));
vi.mock('@/pages/v2/communication/PhoneTabPage', () => ({
  default: () => <div>Phone Shell</div>,
}));

import { useFeature } from '@/lib/entitlements';
import RequireCommunicationCreate from '@/components/RequireCommunicationCreate';
import PhoneTabPage from '@/pages/v2/communication/PhoneTabPage';

function Dashboard() {
  return <div>Dashboard Screen</div>;
}

function renderPhoneRoute(options: { ability: AppAbility }) {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route element={<RequireCommunicationCreate />}>
        <Route path="/phone" element={<PhoneTabPage />} />
      </Route>
    </Routes>,
    { initialEntries: ['/phone'], ability: options.ability },
  );
}

describe('/phone route guard (Task A3)', () => {
  it('redirects to "/" when the org lacks Communication access, even with the CASL grant', () => {
    vi.mocked(useFeature).mockReturnValue(false);
    const ability = buildAbility([{ action: 'create', subject: 'Communication' }]);

    renderPhoneRoute({ ability });

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
    expect(screen.queryByText('Phone Shell')).not.toBeInTheDocument();
  });

  it('redirects to "/" when the user lacks the create-Communication grant, even with org access', () => {
    vi.mocked(useFeature).mockReturnValue(true);

    renderPhoneRoute({ ability: emptyAbility });

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
    expect(screen.queryByText('Phone Shell')).not.toBeInTheDocument();
  });

  it('renders the /phone shell for a permitted user (org access + CASL grant)', () => {
    vi.mocked(useFeature).mockReturnValue(true);
    const ability = buildAbility([{ action: 'create', subject: 'Communication' }]);

    renderPhoneRoute({ ability });

    expect(screen.getByText('Phone Shell')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard Screen')).not.toBeInTheDocument();
  });
});
