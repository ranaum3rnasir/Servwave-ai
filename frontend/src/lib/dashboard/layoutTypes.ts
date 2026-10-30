import type { ReactNode } from 'react';
import type { DashboardTileData, DashboardTileMeta } from '@/lib/api/dashboard';

export type WidgetSize = 'kpi' | 'third' | 'half' | 'full'; // grid spans 2 / 4 / 6 / 12 of 12
export type TimeRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface LayoutItem {
  id: string;
  visible: boolean;
  size?: WidgetSize;
  range?: TimeRange;
  /**
   * `false` marks a stored tile the person cannot have right now (PRD 9). The server keeps it in the list so a save keeps
   * it in place; the page never draws it, counts it or offers it in the picker (the layout hook leaves it out).
   */
  available?: false;
}
export type DashboardLayout = LayoutItem[];

export interface WidgetRenderCtx {
  /** Each eligible tile's data, keyed by the tile's id (undefined until the first answer lands). */
  data: DashboardTileData | undefined;
  /** This tile's category, mode and label as the server sent them; the label shows next to a money tile's title. */
  tile?: DashboardTileMeta;
  range: TimeRange;
  navigate: (to: string) => void;
  /**
   * True only for the first fetch (no cached data yet) - see useDashboard().
   * Optional: only the v2 dashboard page (the one actually routed) supplies
   * it; the unrouted legacy page does not.
   */
  isLoading?: boolean;
}

export interface WidgetDef {
  id: string;
  title: string;
  defaultSize: WidgetSize;
  defaultVisible: boolean;
  defaultRange?: TimeRange;
  render: (ctx: WidgetRenderCtx) => ReactNode;
}

export const SIZE_SPAN: Record<WidgetSize, string> = {
  kpi: 'col-span-6 sm:col-span-3 lg:col-span-2',
  third: 'col-span-12 lg:col-span-4',
  half: 'col-span-12 lg:col-span-6',
  full: 'col-span-12',
};
