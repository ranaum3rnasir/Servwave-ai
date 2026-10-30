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
   * The Show switch of the page this item belongs to (Roles & Permissions S02.24). An item shows only when its Create
   * ability (`action` on `subject`) AND this switch are both on. Show is display only, so it is read from the person's
   * own resolved switches, never from a rule.
   */
  show: string;
}

export const quickCreateItems: QuickCreateItem[] = [
  { label: 'New Lead', href: '/leads/new', icon: Target, action: 'create', subject: 'Lead', show: 'show_leads_page' },
  { label: 'New Customer', href: '/customers/new', icon: Users, action: 'create', subject: 'Customer', show: 'show_customers_page' },
  { label: 'New Estimate', href: '/estimates?action=new-estimate', icon: FileText, action: 'create', subject: 'Estimate', show: 'show_estimates_page' },
  { label: 'New Job', href: '/jobs/new', icon: Briefcase, action: 'create', subject: 'Job', show: 'show_jobs_page' },
  { label: 'New Task', href: '/tasks?action=new-task', icon: ClipboardList, action: 'create', subject: 'Task', show: 'show_tasks_page' },
  // Standalone invoice (customer-anchored, no job/estimate): it follows the Standalone invoices switch, not Create
  // invoices, which only makes an invoice from a job or an estimate.
  { label: 'New Invoice', href: '/invoices/new', icon: Receipt, action: 'create_standalone', subject: 'Invoice', show: 'show_invoices_page' },
];

/**
 * Whether a create shortcut shows for a person: its Create ability and its page's Show switch are both on. Until the
 * person's switches have arrived nothing shows, the same rule the menu entries follow. An item that creates nothing
 * (the dashboard's Request Payment) carries no `action` / `subject` and follows its Show switch alone.
 */
export function quickCreateItemShows(
  item: Pick<QuickCreateItem, 'show'> & Partial<Pick<QuickCreateItem, 'action' | 'subject'>>,
  can: (action: AppAction, subject: AppSubject) => boolean,
  values: Record<string, unknown> | undefined,
): boolean {
  if (values?.[item.show] !== true) return false;
  return item.action === undefined || item.subject === undefined || can(item.action, item.subject);
}
