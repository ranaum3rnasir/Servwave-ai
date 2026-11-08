import { describe, it, expect } from 'vitest';
import {
  getDestination, hasNavFeature, isNavChildLocked, resolveNavHref, visibleNavChildren,
  type NavAccess,
} from '../nav-registry';

/**
 * The shared nav-access helpers both sidebars read (legacy `Sidebar` and the
 * kit-based `V2AppLayout`). They exist so "which child is reachable" is answered
 * ONCE - two copies drift the moment one learns about a key the other has not,
 * and the symptom is a nav row pointing at a route that bounces to /upgrade.
 *
 * Communication is the case that forced them: email left the `phone` master
 * switch, so the group now holds two keys and its declared href
 * (`/communication/phone`) is a dead link for an org entitled to email only.
 */
function access(overrides: Partial<NavAccess> = {}): NavAccess {
  return {
    can: () => true,
    orgFeatures: [],
    entitlementsReady: true,
    isDemoOrg: false,
    ...overrides,
  };
}

const communication = getDestination('communication')!;

describe('hasNavFeature', () => {
  it('treats an array of keys as OR - any one of them unlocks the row', () => {
    expect(hasNavFeature(['phone', 'email'], access({ orgFeatures: ['email'] }))).toBe(true);
    expect(hasNavFeature(['phone', 'email'], access({ orgFeatures: ['phone'] }))).toBe(true);
    expect(hasNavFeature(['phone', 'email'], access({ orgFeatures: [] }))).toBe(false);
  });

  it('still accepts a single key, and treats an absent key as ungated', () => {
    expect(hasNavFeature('phone', access({ orgFeatures: ['phone'] }))).toBe(true);
    expect(hasNavFeature('phone', access({ orgFeatures: ['email'] }))).toBe(false);
    expect(hasNavFeature(undefined, access())).toBe(true);
  });

  it('fails OPEN before the entitlement payload lands', () => {
    // Same contract as useFeature: a cold cache must not grey out every module
    // on first paint. The real boundary is the backend 402.
    expect(hasNavFeature('phone', access({ orgFeatures: [], entitlementsReady: false }))).toBe(true);
  });
});

describe('visibleNavChildren (Communication)', () => {
  it('shows only Email for an org entitled to email but not phone', () => {
    const children = visibleNavChildren(communication, access({ orgFeatures: ['email'] }));
    expect(children.map((c) => c.key)).toEqual(['comm-email']);
  });

  it('shows the phone channels but not Email for a phone-only org', () => {
    const children = visibleNavChildren(communication, access({ orgFeatures: ['phone'] }));
    expect(children.map((c) => c.key)).toEqual(['comm-phone', 'comm-whatsapp', 'comm-text']);
  });

  it('shows all four for an org entitled to both', () => {
    const children = visibleNavChildren(communication, access({ orgFeatures: ['phone', 'email'] }));
    expect(children.map((c) => c.key)).toEqual([
      'comm-phone', 'comm-whatsapp', 'comm-email', 'comm-text',
    ]);
  });

  it('keeps a demo-only child in the list - it renders LOCKED, never hidden', () => {
    // A hidden row whose route still resolves is not a gate, it is just a row
    // you cannot find. WhatsApp stays visible and locked for a real org.
    const real = access({ orgFeatures: ['phone', 'email'], isDemoOrg: false });
    const whatsapp = visibleNavChildren(communication, real).find((c) => c.key === 'comm-whatsapp');
    expect(whatsapp).toBeDefined();
    expect(isNavChildLocked(whatsapp!, real)).toBe(true);
    expect(isNavChildLocked(whatsapp!, { ...real, isDemoOrg: true })).toBe(false);
  });

  it('drops a child the ability forbids, entitlement notwithstanding', () => {
    const noComm = access({ orgFeatures: ['phone', 'email'], can: () => false });
    expect(visibleNavChildren(communication, noComm)).toEqual([]);
  });
});

describe('resolveNavHref', () => {
  it('lands an email-only org on the inbox, not the dead /communication/phone', () => {
    expect(resolveNavHref(communication, access({ orgFeatures: ['email'] })))
      .toBe('/communication/inbox');
  });

  it('lands a phone org on the phone hub', () => {
    expect(resolveNavHref(communication, access({ orgFeatures: ['phone', 'email'] })))
      .toBe('/communication/phone');
  });

  it('skips a demo-locked child when picking the landing target', () => {
    // A real org entitled to phone whose only other reachable child is WhatsApp
    // must not land on a route <DemoOnlyRoute> will bounce.
    const phoneOnlyChildren = {
      ...communication,
      children: communication.children!.filter((c) => c.key !== 'comm-phone' && c.key !== 'comm-text'),
    };
    expect(resolveNavHref(phoneOnlyChildren, access({ orgFeatures: ['phone', 'email'] })))
      .toBe('/communication/inbox');
  });

  it('falls back to the declared href when no child qualifies', () => {
    expect(resolveNavHref(communication, access({ orgFeatures: [] })))
      .toBe(communication.href);
  });

  it('leaves a childless destination alone', () => {
    const jobs = getDestination('jobs')!;
    expect(resolveNavHref(jobs, access())).toBe('/jobs');
  });
});
