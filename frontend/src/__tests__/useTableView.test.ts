import { describe, it, expect } from 'vitest'
import { applySavedView } from '../hooks/useTableView'
import type { TableViewConfig, ColumnPref } from '../lib/api/table-views'

type ColumnDef = { id: string; minWidth?: number; maxWidth?: number; locked?: boolean }

// ─── Test 1: Returns defaults when saved is null ──────────
describe('applySavedView', () => {
  it('returns defaults when saved is null', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
      status: { width: 100, visible: true },
    }
    const cols: ColumnDef[] = [{ id: 'name' }, { id: 'status' }]
    const result = applySavedView(defaults, null, cols)
    expect(result).toEqual(defaults)
  })

  // ─── Test 2: Applies saved width and visibility ───────
  it('applies saved width and visibility', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
      status: { width: 100, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 300, visible: true },
        status: { width: 80, visible: false },
      },
    }
    const cols: ColumnDef[] = [{ id: 'name' }, { id: 'status' }]
    const result = applySavedView(defaults, saved, cols)
    expect(result['name']!.width).toBe(300)
    expect(result['status']!.visible).toBe(false)
  })

  // ─── Test 3: Ignores unknown column ids in saved ──────
  it('ignores unknown column ids in saved', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 250, visible: true },
        ghost: { width: 999, visible: false },
      },
    }
    const cols: ColumnDef[] = [{ id: 'name' }]
    const result = applySavedView(defaults, saved, cols)
    expect('ghost' in result).toBe(false)
    expect(result['name']!.width).toBe(250)
  })

  // ─── Test 4: Fills missing columns with defaults ──────
  it('fills missing columns with system defaults', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
      status: { width: 100, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 250, visible: true },
        // status is missing from saved
      },
    }
    const cols: ColumnDef[] = [{ id: 'name' }, { id: 'status' }]
    const result = applySavedView(defaults, saved, cols)
    expect(result['status']).toEqual({ width: 100, visible: true })
  })

  // ─── Test 5: Clamps saved width below minWidth ────────
  it('clamps saved width up to minWidth when below', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 10, visible: true },
      },
    }
    const cols: ColumnDef[] = [{ id: 'name', minWidth: 64 }]
    const result = applySavedView(defaults, saved, cols)
    expect(result['name']!.width).toBe(64)
  })

  // ─── Test 6: Clamps saved width above maxWidth ────────
  it('clamps saved width down to maxWidth when above', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 9999, visible: true },
      },
    }
    const cols: ColumnDef[] = [{ id: 'name', maxWidth: 400 }]
    const result = applySavedView(defaults, saved, cols)
    expect(result['name']!.width).toBe(400)
  })

  // ─── Test 7: Forces locked column visible ─────────────
  it('forces locked column visible even if saved has it hidden', () => {
    const defaults: Record<string, ColumnPref> = {
      name: { width: 200, visible: true },
    }
    const saved: TableViewConfig = {
      version: 1,
      columns: {
        name: { width: 200, visible: false },
      },
    }
    const cols: ColumnDef[] = [{ id: 'name', locked: true }]
    const result = applySavedView(defaults, saved, cols)
    expect(result['name']!.visible).toBe(true)
  })
})
