// #2046 — SALES must not see the Communication section: sidebar group, /communication/*
// pages. The lead/job Communication TAB stays.
//
// Chosen gate (mirrors the backend repro's rationale — see repro-2046.test.ts's header):
// a NEW action `access_inbox` on the EXISTING subject `Communication`, kept in lockstep with
// the frontend `AppAction` union (frontend/src/lib/ability.ts) the same way `log_past` already
// is. `access_inbox` is not yet a member of that union — that is the fix stage's job — so every
// rule using it below is cast through `AbilityRule` explicitly, the same way a not-yet-wired
// grant shape is asserted anywhere else in this codebase before the type catches up with it.
//
// Surfaces exercised:
//   1. buildNavSections — the Communication group + its four children (nav-registry.ts:211-221)
//      are gated on `read Communication` alone (Sidebar.tsx:148 does no second check). RED today.
//   2. The /communication/* route guard (communication.routes.tsx:58) is `<ProtectedRoute
//      allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}>` — a ROLE list, not an ability
//      check at all. There is no ability-consuming gate at the route level to exercise; testing
//      "an ability redirects" would only be testing a mock we invented, not real code. This is
//      documented here as UNRENDERABLE against real code and left to the Lead's ui-checks.md
//      instead — see the trailing comment block.
//   3. LeadCommunicationsTab renders for `read Communication` alone — GREEN, must stay (it is a
//      separate, already anchor-scoped code path over GET /api/leads/:id/communications).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import { buildNavSections } from '@/pages/v2/buildNavSections';
import { NAV_SECTIONS } from '@/pages/v2/navSections';
import { DEFAULT_LAYOUT_KEYS, getDestination } from '@/components/layout/nav-registry';
import { LeadCommunicationsTab } from '@/components/communication/LeadCommunicationsTab';

const mockApi = vi.mocked(api);

// Same seams lead-communications-tab.test.tsx mocks, so the tab's real hooks run without
// dragging in the softphone/entitlements graph.
const commAccess = vi.hoisted(() => ({ value: true }));
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => commAccess.value,
}));
vi.mock('@/lib/communication/phoneTabHandoff', () => ({ requestCall: vi.fn() }));
vi.mock('@/components/communication/shared/EntityCallDrawer', () => ({
  EntityCallDrawer: () => <div data-testid="entity-call-drawer" />,
}));
vi.mock('@/components/communication/shared/EntitySmsDrawer', () => ({
  EntitySmsDrawer: () => <div data-testid="entity-sms-drawer" />,
}));

vi.mock('@/lib/axios');

beforeEach(() => {
  vi.clearAllMocks();
  commAccess.value = true;
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1. buildNavSections — the Communication group is keyed on `read Communication` alone today
// ═══════════════════════════════════════════════════════════════════════════════════════════

function rowsFor(sections: ReturnType<typeof buildNavSections>) {
  return sections.flatMap((s) => s.items.flatMap((item) => [item, ...(item.children ?? [])]));
}

function buildSections(ability: ReturnType<typeof buildAbility>) {
  return buildNavSections({
    keys: DEFAULT_LAYOUT_KEYS,
    sections: NAV_SECTIONS,
    getDestination,
    can: ability.can.bind(ability),
    isLocked: () => false,
    isFeatureLocked: () => false,
  });
}

// SALES-shaped: unconditional `read Communication`, no section gate — the exact grant SALES
// holds live today (prod Pass A: `GET /api/auth/me` → `{"action":"read","subject":
// "Communication"}`, no `conditions`).
const readOnlyCommAbility = () => buildAbility([{ action: 'read', subject: 'Communication' }]);

// The shape the fix's migration is expected to write for DISPATCHER/TECHNICIAN/ADMIN: `read`
// PLUS the new section gate. `access_inbox` is not yet in the AppAction union — cast through
// AbilityRule, same as the backend repro hand-injects the not-yet-cataloged grant row.
const sectionGateAbility = () =>
  buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' } as unknown as AbilityRule,
  ]);

describe('#2046 buildNavSections — Communication group visibility', () => {
  it('shows the Communication group + all four children to `read Communication` alone (today — no section gate exists yet)', () => {
    const labels = rowsFor(buildSections(readOnlyCommAbility())).map((r) => r.dest.label);
    // RED: the desired end-state is that a read-only-Communication ability (SALES's real shape)
    // must NOT see the group. Today it does — this assertion documents and fails on that gap.
    expect(labels).not.toContain('Communication');
  });

  it('keeps the four Communication children hidden from `read Communication` alone (today — they render, RED)', () => {
    const labels = rowsFor(buildSections(readOnlyCommAbility())).map((r) => r.dest.label);
    expect(labels).not.toContain('Phone');
    expect(labels).not.toContain('Text');
  });

  it('keeps the Communication group + children for an ability holding the section gate (must stay green)', () => {
    const labels = rowsFor(buildSections(sectionGateAbility())).map((r) => r.dest.label);
    expect(labels).toContain('Communication');
    expect(labels).toContain('Phone');
    expect(labels).toContain('Text');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2. UNRENDERABLE: the /communication/* route guard (communication.routes.tsx:58) is
// `<ProtectedRoute allowedRoles={[...]}>` — a role-list check with NO ability parameter
// anywhere in ProtectedRoute.tsx. There is no code path today where an AppAbility affects this
// component's redirect decision, so a test that passes it an ability and asserts a redirect
// would only be proving our own test double, not exercising real code — exactly the anti-pattern
// the TDD skill warns against ("testing mock behaviour instead of real behaviour").
//
// The real, honest reproduction of TODAY's mechanism is role-based: `allowedRoles` explicitly
// lists SALES (communication.routes.tsx:58), so a SALES-role request reaches every
// /communication/* route regardless of ability. Left to the Lead's ui-checks.md browser pass
// (recipes/ui-checks.md — sidebar + direct-URL navigation as the qa-2046 SALES fixture) rather
// than an automated frozen test, because whatever mechanism the fix adds here (narrowing
// allowedRoles, or wrapping the route in an ability-consuming guard) does not exist yet to pin a
// failing assertion against.
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 3. LeadCommunicationsTab — must stay reachable for `read Communication` alone
// ═══════════════════════════════════════════════════════════════════════════════════════════

const LEAD_ID = 'e0000000-0000-0000-0000-000000000001';
const LEAD_LABEL = 'L00001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const CUSTOMER_NAME = 'qa-2046-customer';

describe('#2046 LeadCommunicationsTab — stays reachable for read-only Communication (must stay)', () => {
  it('renders the lead comms timeline for an ability holding ONLY `read Communication` (no section gate)', async () => {
    mockApi.get.mockResolvedValue({
      data: {
        items: [
          {
            id: 'ca000000-0000-0000-0000-000000000011',
            channel: 'call',
            direction: 'out',
            who: '+15125550100',
            title: 'Outbound call · 0m 30s',
            preview: 'qa-2046 lead message',
            at: '2026-06-01T14:32:00.000Z',
            leadId: LEAD_ID,
            leadLabel: LEAD_LABEL,
          },
        ],
      },
    });

    renderWithProviders(
      <LeadCommunicationsTab
        leadId={LEAD_ID}
        leadLabel={LEAD_LABEL}
        customerId={CUSTOMER_ID}
        customerName={CUSTOMER_NAME}
      />,
      { ability: readOnlyCommAbility() },
    );

    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith(`/api/leads/${LEAD_ID}/communications`),
    );
    expect(await screen.findByText('Outbound call · 0m 30s')).toBeInTheDocument();
  });
});
