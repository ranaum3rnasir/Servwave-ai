import type { ReactNode } from 'react';
import type { DashboardResponse } from '@/lib/api/dashboard';

export type WidgetSize = 'kpi' | 'third' | 'half' | 'full'; // grid spans 2 / 4 / 6 / 12 of 12
export type TimeRange = 'today' | '7d' | '30d' | 'month' | 'all';

export interface LayoutItem {
  id: string;
  visible: boolean;
  size?: WidgetSize;
  range?: TimeRange;
}
export type DashboardLayout = LayoutItem[];

export interface WidgetRenderCtx {
  data: DashboardResponse | undefined;
  range: TimeRange;
  navigate: (to: string) => void;
}

export interface WidgetDef {
  id: string;
  title: string;
  category: 'KPI' | 'Operations' | 'Financial' | 'Sales' | 'Pipeline' | 'Team';
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
