import { act } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import type { ChangeLogEntry } from '@/lib/api/permissionChangeLog';

/**
 * A stand-in for the two change log reads, in the shape the server answers: newest first, a page of `limit` entries
 * from `offset`, `has_more` while older ones remain, and the log's size on the first page only. Plus a double for the
 * browser's intersection observer, which jsdom does not have, so a test can scroll the log to its end.
 */

let sequence = 0;

/** One entry, a plain manual edit by a named person unless it says otherwise. */
export function logEntry(over: Partial<ChangeLogEntry> = {}): ChangeLogEntry {
  sequence += 1;
  return {
    id: `entry-${sequence}`,
    switch_key: 'view_customers',
    switch_label: 'View customers',
    from: false,
    to: true,
    reason: 'manual',
    role_label: null,
    created_at: '2026-03-05T02:30:00.000Z',
    actor: { id: 'actor-1', name: 'Dana Admin' },
    ...over,
  };
}

/** Answers `GET <log>?limit&offset` from `entries`, and counts the calls. */
export function logServer(entries: ChangeLogEntry[]) {
  const offsets: number[] = [];
  const answer = (config?: { params?: { limit?: number; offset?: number } }) => {
    const limit = config?.params?.limit ?? 50;
    const offset = config?.params?.offset ?? 0;
    offsets.push(offset);
    return {
      data: {
        total: offset === 0 ? entries.length : null,
        has_more: offset + limit < entries.length,
        entries: entries.slice(offset, offset + limit),
      },
    };
  };
  return { answer, offsets };
}

interface Watcher {
  callback: IntersectionObserverCallback;
  active: boolean;
}

let watchers: Watcher[] = [];

class ObserverDouble {
  private readonly watcher: Watcher;
  constructor(callback: IntersectionObserverCallback) {
    this.watcher = { callback, active: true };
    watchers.push(this.watcher);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.watcher.active = false;
  }
  takeRecords() {
    return [];
  }
}

/** Installs the double for each test in the file, and removes it after. */
export function installObserverDouble() {
  const original = globalThis.IntersectionObserver;
  beforeEach(() => {
    watchers = [];
    globalThis.IntersectionObserver = ObserverDouble as unknown as typeof IntersectionObserver;
  });
  afterEach(() => {
    globalThis.IntersectionObserver = original;
  });
}

/** Scrolls the log to its end: every watcher still watching hears that its edge came into view. */
export async function reachEnd() {
  await act(async () => {
    for (const w of watchers.filter((x) => x.active)) {
      w.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

/** How many watchers are still watching: a log with nothing older to load watches nothing. */
export const watching = () => watchers.filter((w) => w.active).length;
