/**
 * Pure flex-fill + sticky-offset layout utility.
 * No DOM, no React, no side effects.
 */

export interface ColumnDef {
  id: string
  width: number
  minWidth: number
  growWeight?: number
  visible: boolean
  manuallySized: boolean
  fixed?: boolean
  pinned?: boolean
  locked?: boolean
}

export interface LayoutInput {
  containerWidth: number
  columns: ColumnDef[]
}

export interface LayoutResult {
  /** Resolved pixel width per visible column id */
  widths: Record<string, number>
  /** Left offset for each pinned column id */
  stickyOffsets: Record<string, number>
  /** True when total resolved width exceeds containerWidth */
  scrolls: boolean
}

/**
 * Determines if a column participates in flex grow distribution.
 * A column grows when it has growWeight > 0, is not fixed, and is not manuallySized.
 */
function isGrowable(col: ColumnDef): boolean {
  return (
    typeof col.growWeight === 'number' &&
    col.growWeight > 0 &&
    !col.fixed &&
    !col.manuallySized
  )
}

export function computeLayout({ containerWidth, columns }: LayoutInput): LayoutResult {
  // Only work with visible columns
  const visible = columns.filter((c) => c.visible)

  // Step 1: Start with base widths
  const widths: Record<string, number> = {}
  for (const col of visible) {
    widths[col.id] = col.width
  }

  // Step 2: Identify growable columns
  const growable = visible.filter(isGrowable)
  const totalGrowWeight = growable.reduce((sum, c) => sum + (c.growWeight ?? 0), 0)

  // Step 3: Compute total base width and surplus
  const totalBase = visible.reduce((sum, c) => sum + c.width, 0)
  const surplus = containerWidth - totalBase

  let scrolls = false

  if (surplus >= 0) {
    // Container is larger than content — distribute surplus or absorb with identity
    if (growable.length > 0 && totalGrowWeight > 0) {
      // Distribute surplus proportionally by grow weight
      for (const col of growable) {
        const share = surplus * ((col.growWeight ?? 0) / totalGrowWeight)
        widths[col.id] = col.width + share
      }
    } else {
      // No dead space fallback: identity column absorbs surplus
      // Identity = first column with locked=true, or first visible growable (none here), or first visible
      const identity =
        visible.find((c) => c.locked) ??
        visible.find((c) => isGrowable(c)) ??
        visible[0]

      if (identity) {
        widths[identity.id] = identity.width + surplus
      }
    }
  } else {
    // Container is smaller than content — shrink growable columns down to minWidth
    // Compute how much we need to recover
    let deficit = -surplus // positive number, amount to recover

    // Compute total shrink headroom from growable columns
    const shrinkable = growable.filter((c) => c.width > c.minWidth)
    const totalShrinkHeadroom = shrinkable.reduce((sum, c) => sum + (c.width - c.minWidth), 0)

    if (totalShrinkHeadroom >= deficit) {
      // We can recover the deficit by shrinking growable columns proportionally
      for (const col of shrinkable) {
        const headroom = col.width - col.minWidth
        const share = deficit * (headroom / totalShrinkHeadroom)
        widths[col.id] = col.width - share
      }
    } else {
      // Even at minWidth, content exceeds container → clamp to minWidth + scrolls
      for (const col of growable) {
        widths[col.id] = col.minWidth
      }
      // Check if total at minWidth still exceeds container
      const totalAtMin = visible.reduce((sum, c) => {
        return sum + (widths[c.id] ?? 0)
      }, 0)
      if (totalAtMin > containerWidth) {
        scrolls = true
      }
    }
  }

  // Step 4: Compute sticky offsets for pinned columns
  // Column order in the input array defines pin order.
  // Offsets are based on RESOLVED widths.
  const stickyOffsets: Record<string, number> = {}
  const pinnedColumns = visible.filter((c) => c.pinned)
  let accumulatedOffset = 0
  for (const col of pinnedColumns) {
    stickyOffsets[col.id] = accumulatedOffset
    accumulatedOffset += (widths[col.id] ?? 0)
  }

  return { widths, stickyOffsets, scrolls }
}
