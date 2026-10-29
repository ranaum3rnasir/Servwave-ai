/**
 * avatar-url-cache.test.ts — lib/avatar.ts's server-side signed-URL cache (2026-08-04 plan,
 * decision 7). Supabase mints a different signed-URL string per createSignedUrls call, so
 * signing on every response would re-download the whole roster's avatars on every refetch and
 * flicker every tile through the fallback. Caching the signed URL — reused until ~80% of its
 * TTL has elapsed — is what stops that.
 *
 * Harness: supabaseAdmin mocked in setup.ts (storage.from() returns one shared handle object,
 * same convention estimate-photos.test.ts uses).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { supabaseAdmin } from '../lib/supabase';
import { signAvatarPaths, evictAvatarUrlCache, resolveAvatarUrl, removeAvatarObject } from '../lib/avatar';

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  createSignedUrls: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('signAvatarPaths', () => {
  it('signs a single path and returns it keyed by path', async () => {
    const result = await signAvatarPaths(['org1/user_profile_photo/u1/1-avatar.jpg']);
    expect(result.get('org1/user_profile_photo/u1/1-avatar.jpg')).toContain('/object/sign/');
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
  });

  it('batches multiple paths into ONE createSignedUrls call, never one per path', async () => {
    const paths = ['org1/user_profile_photo/u2/1.jpg', 'org1/user_profile_photo/u3/1.jpg', 'org1/user_profile_photo/u4/1.jpg'];
    const result = await signAvatarPaths(paths);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(storage.createSignedUrls).toHaveBeenCalledWith(paths, expect.any(Number));
    for (const p of paths) expect(result.get(p)).toBeTruthy();
  });

  it('filters out null/undefined entries and dedupes repeats before signing', async () => {
    const result = await signAvatarPaths(['org1/user_profile_photo/u5/1.jpg', null, undefined, 'org1/user_profile_photo/u5/1.jpg']);
    expect(storage.createSignedUrls).toHaveBeenCalledWith(['org1/user_profile_photo/u5/1.jpg'], expect.any(Number));
    expect(result.size).toBe(1);
  });

  it('returns an empty map with no Storage call for an all-empty input', async () => {
    const result = await signAvatarPaths([null, undefined]);
    expect(storage.createSignedUrls).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('reuses a cached signed URL on a second call for the same path, within the TTL', async () => {
    const path = 'org1/user_profile_photo/u6/1.jpg';
    const first = await signAvatarPaths([path]);
    const second = await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(second.get(path)).toBe(first.get(path));
  });

  it('re-signs once ~80% of the 1h TTL has elapsed', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T12:00:00Z') });
    const path = 'org1/user_profile_photo/u7/1.jpg';
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);

    // 47 minutes in — still within the 80%-of-60min reuse window.
    vi.setSystemTime(new Date('2026-08-04T12:47:00Z'));
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);

    // 49 minutes in — past the 48-minute reuse window, must re-sign.
    vi.setSystemTime(new Date('2026-08-04T12:49:00Z'));
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('degrades to an empty map (never throws) when Storage signing errors', async () => {
    storage.createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    const result = await signAvatarPaths(['org1/user_profile_photo/u8/1.jpg']);
    expect(result.size).toBe(0);
  });

  it('degrades to an empty map (never throws) when Storage signing rejects', async () => {
    storage.createSignedUrls.mockRejectedValueOnce(new Error('network down'));
    const result = await signAvatarPaths(['org1/user_profile_photo/u9/1.jpg']);
    expect(result.size).toBe(0);
  });
});

describe('evictAvatarUrlCache', () => {
  it('forces a re-sign on the next call for the evicted path', async () => {
    const path = 'org1/user_profile_photo/u10/1.jpg';
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);

    evictAvatarUrlCache(path);
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  });
});

describe('resolveAvatarUrl', () => {
  it('returns the signed url for a path present in the map', () => {
    const signed = new Map([['org1/a.jpg', 'https://signed/a.jpg']]);
    expect(resolveAvatarUrl('org1/a.jpg', signed)).toBe('https://signed/a.jpg');
  });

  it('returns null for a null/undefined path without touching the map', () => {
    const signed = new Map([['org1/a.jpg', 'https://signed/a.jpg']]);
    expect(resolveAvatarUrl(null, signed)).toBeNull();
    expect(resolveAvatarUrl(undefined, signed)).toBeNull();
  });

  it('returns null for a path that failed to sign (a real path, no map entry)', () => {
    expect(resolveAvatarUrl('org1/missing.jpg', new Map())).toBeNull();
  });
});

describe('removeAvatarObject', () => {
  it('calls Storage remove with the path and evicts it from the signed-URL cache', async () => {
    const path = 'org1/user_profile_photo/u11/1.jpg';
    await signAvatarPaths([path]); // populate the cache
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);

    await removeAvatarObject(path);
    expect(storage.remove).toHaveBeenCalledWith([path]);

    // Cache was evicted — a re-sign is required.
    await signAvatarPaths([path]);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(2);
  });

  it('never throws when Storage remove errors or rejects', async () => {
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    await expect(removeAvatarObject('org1/a.jpg')).resolves.toBeUndefined();

    storage.remove.mockRejectedValueOnce(new Error('network down'));
    await expect(removeAvatarObject('org1/b.jpg')).resolves.toBeUndefined();
  });
});
