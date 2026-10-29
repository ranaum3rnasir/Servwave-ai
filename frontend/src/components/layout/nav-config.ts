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
}

export const quickCreateItems: QuickCreateItem[] = [
  { label: 'New Lead', href: '/leads/new', icon: Target, action: 'create', subject: 'Lead' },
  { label: 'New Customer', href: '/customers/new', icon: Users, action: 'create', subject: 'Customer' },
  { label: 'New Estimate', href: '/estimates?action=new-estimate', icon: FileText, action: 'create', subject: 'Estimate' },
  { label: 'New Job', href: '/jobs/new', icon: Briefcase, action: 'create', subject: 'Job' },
  { label: 'New Task', href: '/tasks?action=new-task', icon: ClipboardList, action: 'create', subject: 'Task' },
  // Standalone invoice (customer-anchored, no job/estimate). A technician holds `create
  // Invoice` only via their own-job-scoped per-user capability, which never satisfies this
  // route's ADMIN + DISPATCHER gate — the route + backend both restrict it there.
  { label: 'New Invoice', href: '/invoices/new', icon: Receipt, action: 'create', subject: 'Invoice' },
];
