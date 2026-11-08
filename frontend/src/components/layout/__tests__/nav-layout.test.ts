import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadLayout, saveLayout, reorder, addKey, removeKey, resetLayout,
} from '../nav-layout';
import { DEFAULT_LAYOUT_KEYS } from '../nav-registry';

describe('nav-layout', () => {
  beforeEach(() => localStorage.clear());

  it('loads the default order when nothing is saved', () => {
    expect(loadLayout('u1')).toEqual(DEFAULT_LAYOUT_KEYS);
  });

  it('round-trips a saved layout per user', () => {
    saveLayout('u1', ['jobs', 'leads']);
    expect(loadLayout('u1')).toEqual(['jobs', 'leads']);
    expect(loadLayout('u2')).toEqual(DEFAULT_LAYOUT_KEYS); // isolated per user
  });

  it('drops unknown keys and falls back if nothing valid remains', () => {
    saveLayout('u1', ['jobs', 'not-real']);
    expect(loadLayout('u1')).toEqual(['jobs']);
    saveLayout('u2', ['nope']);
    expect(loadLayout('u2')).toEqual(DEFAULT_LAYOUT_KEYS);
  });

  it('reorders by moving an index', () => {
    expect(reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('adds (idempotent) and removes keys', () => {
    expect(addKey(['a'], 'b')).toEqual(['a', 'b']);
    expect(addKey(['a', 'b'], 'b')).toEqual(['a', 'b']);
    expect(removeKey(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('resetLayout writes and returns the default', () => {
    saveLayout('u1', ['jobs']);
    expect(resetLayout('u1')).toEqual(DEFAULT_LAYOUT_KEYS);
    expect(loadLayout('u1')).toEqual(DEFAULT_LAYOUT_KEYS);
  });

  it('appends a newly-shipped default to a pre-version (legacy) layout, once, at the end', () => {
    // A layout saved before the version system: bare array, NO version key.
    localStorage.setItem('servwave:nav-layout:u1', JSON.stringify(['jobs', 'leads']));

    const first = loadLayout('u1');
    expect(first.slice(0, 2)).toEqual(['jobs', 'leads']); // original order preserved
    expect(first).toContain('service-plans');             // new default appended
    // Idempotent: now stamped at the current version, a second load does not append again.
    expect(loadLayout('u1')).toEqual(first);
  });

  it('does NOT re-add a default the user removed at the current version', () => {
    // saveLayout stamps the current version, so the migration treats this as up-to-date.
    saveLayout('u1', ['jobs', 'leads']);
    expect(loadLayout('u1')).toEqual(['jobs', 'leads']); // service-plans NOT re-added
  });
});
