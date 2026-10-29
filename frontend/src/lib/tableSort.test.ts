import { describe, it, expect } from 'vitest';
import { toggleColumnSort } from './tableSort';

const ALWAYS_SORTED = new Set(['created', 'lead_number']);

describe('toggleColumnSort - regular column (has an unsorted state)', () => {
  it('engaging a column not currently sorted goes ascending first', () => {
    expect(toggleColumnSort([], 'status', ALWAYS_SORTED)).toEqual([{ id: 'status', desc: false }]);
  });

  it('ascending -> descending', () => {
    expect(toggleColumnSort([{ id: 'status', desc: false }], 'status', ALWAYS_SORTED))
      .toEqual([{ id: 'status', desc: true }]);
  });

  it('descending -> cleared (unsorted)', () => {
    expect(toggleColumnSort([{ id: 'status', desc: true }], 'status', ALWAYS_SORTED)).toEqual([]);
  });

  it('switching from a different active column starts ascending, not wherever the old column was', () => {
    expect(toggleColumnSort([{ id: 'created', desc: true }], 'status', ALWAYS_SORTED))
      .toEqual([{ id: 'status', desc: false }]);
  });
});

describe('toggleColumnSort - always-sorted column (# / date, no unsorted state)', () => {
  it('engaging it goes descending first, not ascending', () => {
    expect(toggleColumnSort([], 'created', ALWAYS_SORTED)).toEqual([{ id: 'created', desc: true }]);
  });

  it('descending -> ascending', () => {
    expect(toggleColumnSort([{ id: 'created', desc: true }], 'created', ALWAYS_SORTED))
      .toEqual([{ id: 'created', desc: false }]);
  });

  it('ascending -> descending again, never clearing', () => {
    expect(toggleColumnSort([{ id: 'created', desc: false }], 'created', ALWAYS_SORTED))
      .toEqual([{ id: 'created', desc: true }]);
  });

  it('switching from a different column lands on descending', () => {
    expect(toggleColumnSort([{ id: 'status', desc: true }], 'lead_number', ALWAYS_SORTED))
      .toEqual([{ id: 'lead_number', desc: true }]);
  });
});
