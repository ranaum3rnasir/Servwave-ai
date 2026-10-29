import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Mobile slice 67. The service worker must LEAVE a new deploy waiting, so the page can offer
 * "Update available" and hold the swap back under unsaved work. A worker that calls
 * `skipWaiting()` on install never waits, so the prompt would never have anything to show and a
 * deploy would swap the offline cache under a half-filled form. This reads the worker's source
 * because the worker cannot run under jsdom.
 */
const source = readFileSync(join(__dirname, '..', 'sw.ts'), 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

describe('src/sw.ts', () => {
  it('does not skip the waiting phase when it installs', () => {
    const install = code.match(/addEventListener\(\s*'install'[\s\S]*?\}\);/);
    expect(install === null || !/skipWaiting/.test(install[0])).toBe(true);
  });

  it('skips waiting only on the page\'s SKIP_WAITING message', () => {
    expect(code).toMatch(/SKIP_WAITING[\s\S]*skipWaiting\(\)/);
    expect(code.match(/skipWaiting\(\)/g)).toHaveLength(1);
  });

  it('claims open pages once it activates', () => {
    expect(code).toMatch(/clients\.claim\(\)/);
  });

  it('no longer carries the comment that says an update must skip the waiting phase', () => {
    expect(source).not.toMatch(/Take over immediately/);
    expect(source).not.toMatch(/we must\./);
  });
});
