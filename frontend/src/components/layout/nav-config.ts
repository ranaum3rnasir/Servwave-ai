import {
  Users,
  Target,
  FileText,
  Briefcase,
  ClipboardList,
  Receipt,
  type LucideIcon,
} from 'lucide-react';
import type { AppAction, AppSubject } from '@/lib/ability';

// The sidebar's nav items live in `nav-registry.ts` (the destination catalog) + the per-user
// customizable layout in `useNavLayout`/`nav-layout.ts`. The old `navSections` / `adminItems` /
// `settingsGearIcon` that used to live here were retired by the customizable-sidebar redesign
// (PR #153) and removed in #164 — adding nav items here did nothing (it caused the
// "Service Plans missing from sidebar" bug). Only the "Create New" quick actions remain.

export interface QuickCreateItem {
  label: string;
  href: string;
  icon: LucideIcon;
  action: AppAction;
  subject: AppSubject;
  /**
   * The View switch of the page this item belongs to (the sidebar follows View, P1). An item shows only when its Create
   * ability (`action` on `subject`) AND this switch are both on. It is read from the person's own resolved switches.
   */
  view: string;
}

export const quickCreateItems: QuickCreateItem[] = [
  { label: 'New Lead', href: '/leads/new', icon: Target, action: 'create', subject: 'Lead', view: 'view_leads' },
  { label: 'New Customer', href: '/customers/new', icon: Users, action: 'create', subject: 'Customer', view: 'view_customers' },
  { label: 'New Estimate', href: '/estimates?action=new-estimate', icon: FileText, action: 'create', subject: 'Estimate', view: 'view_estimates' },
  { label: 'New Job', href: '/jobs/new', icon: Briefcase, action: 'create', subject: 'Job', view: 'view_jobs' },
  { label: 'New Task', href: '/tasks?action=new-task', icon: ClipboardList, action: 'create', subject: 'Task', view: 'view_tasks' },
  // Standalone invoice (customer-anchored, no job/estimate): it follows the Standalone invoices switch, not Create
  // invoices, which only makes an invoice from a job or an estimate.
  { label: 'New Invoice', href: '/invoices/new', icon: Receipt, action: 'create_standalone', subject: 'Invoice', view: 'view_invoices' },
];

/**
 * Whether a create shortcut shows for a person: its Create ability and its page's View switch are both on. Until the
 * person's switches have arrived nothing shows, the same rule the menu entries follow. An item that creates nothing
 * (the dashboard's Request Payment) carries no `action` / `subject` and follows its View switch alone.
 */
export function quickCreateItemShows(
  item: Pick<QuickCreateItem, 'view'> & Partial<Pick<QuickCreateItem, 'action' | 'subject'>>,
  can: (action: AppAction, subject: AppSubject) => boolean,
  values: Record<string, unknown> | undefined,
): boolean {
  if (values?.[item.view] !== true) return false;
  return item.action === undefined || item.subject === undefined || can(item.action, item.subject);
}
