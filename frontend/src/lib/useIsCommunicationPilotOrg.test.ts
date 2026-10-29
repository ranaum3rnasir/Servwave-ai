/// <reference types="@testing-library/jest-dom/vitest" />
// The allowlist check for the still-unfinished CTM pilot sub-surfaces (Call
// flows / Call groups / Call training): real pilot orgs ONLY, deliberately
// excluding demo. Callers (PhonePage) OR this with `useIsDemoOrg` so the
// pilot org and the demo showcase both see them, while every other real org
// is locked out. Unrelated to the `phone` plan entitlement, which gates the
// module itself (see lib/entitlements).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@/stores/auth.store', () => ({ useAuthStore: vi.fn() }));

import { useAuthStore } from '@/stores/auth.store';
import { useIsCommunicationPilotOrg } from '@/lib/useIsCommunicationPilotOrg';

// Alpha Doors & Security — the Phase-0 CTM pilot (same id in staging + prod, and
// the hardcoded default when VITE_COMMUNICATION_ALLOWED_ORG_IDS is unset).
const ALPHA_DOORS_ORG_ID = 'd40afcec-0ddf-471f-b99d-8e5f23cbdadf';

function mockUser(user: unknown) {
  vi.mocked(useAuthStore).mockImplementation((sel: any) => sel({ user }));
}

describe('useIsCommunicationPilotOrg (flows/groups/training gate)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is true ONLY for the allowlisted pilot org', () => {
    mockUser({ organization_id: ALPHA_DOORS_ORG_ID, org_is_demo: false });
    expect(renderHook(() => useIsCommunicationPilotOrg()).result.current).toBe(true);
  });

  // This hook is allowlist-only by design — demo orgs unlock flows/groups
  // through a separate `useIsDemoOrg` check at the call site (PhonePage), not
  // through this hook falling through to true.
  it('is false for a demo org — the allowlist check never falls through to demo', () => {
    mockUser({ organization_id: 'demo-xyz', org_is_demo: true });
    expect(renderHook(() => useIsCommunicationPilotOrg()).result.current).toBe(false);
  });

  it('is false for an unlisted real org', () => {
    mockUser({ organization_id: 'some-other-real-org', org_is_demo: false });
    expect(renderHook(() => useIsCommunicationPilotOrg()).result.current).toBe(false);
  });

  it('is false when signed out', () => {
    mockUser(null);
    expect(renderHook(() => useIsCommunicationPilotOrg()).result.current).toBe(false);
  });
});
