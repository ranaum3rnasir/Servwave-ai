import type { DashboardLayout, LayoutItem, TimeRange, WidgetSize } from './layoutTypes';

/**
 * The layout a browser kept for the home page before layouts lived on the server (Roles & Permissions, PRD 9, S09.5).
 * Nothing writes it any more. It is read once, to carry a customised layout to the server, and then cleared.
 *
 * The key and shape are the ones the page always stored: `alpha:dashboard-layout:v1:<person id>` holding a JSON list
 * of `{ id, visible, size?, range? }`. The person's id is in the key, so one person's copy is never read for another
 * who signs in on the same browser. Every read and write sits in try/catch: private windows and blocked site data throw.
 */
const KEY = (userId: string) => `alpha:dashboard-layout:v1:${userId}`;

const SIZES: readonly WidgetSize[] = ['kpi', 'third', 'half', 'full'];
const RANGES: readonly TimeRange[] = ['today', '7d', '30d', 'month', 'all'];
/** More tiles than this cannot be a layout (the server turns a longer list away too), so it is read as damaged. */
const MAX_ENTRIES = 500;

function entryOf(raw: unknown): LayoutItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, visible, size, range } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof visible !== 'boolean') return null;
  const entry: LayoutItem = { id, visible };
  if (SIZES.includes(size as WidgetSize)) entry.size = size as WidgetSize;
  if (RANGES.includes(range as TimeRange)) entry.range = range as TimeRange;
  return entry;
}

/** The person's browser layout, or null when there is none worth carrying over (absent, damaged or unreadable). */
export function readBrowserLayout(userId: string | undefined): DashboardLayout | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(KEY(userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES) return null;
    const seen = new Set<string>();
    const layout: DashboardLayout = [];
    for (const item of parsed) {
      const entry = entryOf(item);
      if (!entry || seen.has(entry.id)) continue;
      seen.add(entry.id);
      layout.push(entry);
    }
    return layout.length > 0 ? layout : null;
  } catch {
    return null;
  }
}

/** Forget the person's browser copy once the server has it. Storage that cannot be written is left as it is. */
export function clearBrowserLayout(userId: string | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(KEY(userId));
  } catch {
    /* storage unavailable: the server copy wins whether or not this is cleared */
  }
}
