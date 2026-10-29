/**
 * Mobile slice 61 (PERF-03): the technician's landing page starts downloading while the sign-in
 * check is still out.
 *
 * A route's chunk is requested only when the router first RENDERS it, and a cold start renders
 * "Loading..." until the sign-in check answers. So the scheduler's chunk (the largest on the
 * landing path) used to start after that round trip, one more step in a chain on a phone line.
 * `preloadLandingRoute` asks for it at entry instead, from the path in the address bar (or, at
 * the app root, from where the cached abilities would send this person).
 */
import { describe, expect, it, vi } from 'vitest';
import { createMongoAbility } from '@casl/ability';
import { buildAbility, emptyAbility, type AbilityRule } from '@/lib/ability';
import { hasStoredSession, preloadLandingRoute } from './preloadLandingRoute';

const noop = () => Promise.resolve({});

function loaders() {
  return { '/schedule': vi.fn(noop) };
}

// What a technician is granted, in the shape the backend sends: no Dashboard, can read jobs.
const technicianRules = [
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Task' },
] as unknown as AbilityRule[];
const adminRules = [{ action: 'manage', subject: 'all' }] as unknown as AbilityRule[];

describe('preloadLandingRoute', () => {
  it('starts the scheduler chunk when the address bar is on /schedule', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/schedule', ability: emptyAbility, signedIn: true, loaders: l });
    expect(l['/schedule']).toHaveBeenCalledTimes(1);
  });

  it('ignores a trailing slash and letter case, as the router does', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/Schedule/', ability: emptyAbility, signedIn: true, loaders: l });
    expect(l['/schedule']).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a route it has no chunk for', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/jobs', ability: buildAbility(technicianRules), signedIn: true, loaders: l });
    preloadLandingRoute({ pathname: '/schedule/extra', ability: emptyAbility, signedIn: true, loaders: l });
    expect(l['/schedule']).not.toHaveBeenCalled();
  });

  it('at the app root, starts the chunk of the page the cached abilities redirect to', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/', ability: buildAbility(technicianRules), signedIn: true, loaders: l });
    expect(l['/schedule']).toHaveBeenCalledTimes(1);
  });

  it('at the app root, starts nothing for someone who lands on the dashboard', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/', ability: buildAbility(adminRules), signedIn: true, loaders: l });
    expect(l['/schedule']).not.toHaveBeenCalled();
  });

  it('at the app root with no cached abilities (first ever visit), guesses nothing', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/', ability: createMongoAbility([]) as never, signedIn: true, loaders: l });
    expect(l['/schedule']).not.toHaveBeenCalled();
  });

  it('someone with no stored sign-in downloads nothing (they are about to be sent to sign in)', () => {
    const l = loaders();
    preloadLandingRoute({ pathname: '/schedule', ability: emptyAbility, signedIn: false, loaders: l });
    expect(l['/schedule']).not.toHaveBeenCalled();
  });

  it('a chunk that fails to load is swallowed here: the router asks again and owns the error', async () => {
    const failing = { '/schedule': vi.fn(() => Promise.reject(new Error('Failed to fetch dynamically imported module'))) };
    expect(() => preloadLandingRoute({ pathname: '/schedule', ability: emptyAbility, signedIn: true, loaders: failing })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    // no unhandled rejection: vitest would fail the run on one
    expect(failing['/schedule']).toHaveBeenCalledTimes(1);
  });
});

describe('hasStoredSession', () => {
  const storageOf = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });

  it('sees the auth client\'s session key', () => {
    expect(hasStoredSession(storageOf(['theme', 'sb-abcdefgh-auth-token']))).toBe(true);
  });

  it('ignores unrelated keys and the auth client\'s other entries', () => {
    expect(hasStoredSession(storageOf(['servwave_user', 'sb-abcdefgh-auth-token-code-verifier']))).toBe(false);
    expect(hasStoredSession(storageOf([]))).toBe(false);
  });

  it('treats blocked storage as signed out instead of throwing', () => {
    const blocked = { get length(): number { throw new Error('denied'); }, key: () => null };
    expect(hasStoredSession(blocked)).toBe(false);
    expect(hasStoredSession(undefined)).toBe(false);
  });
});
