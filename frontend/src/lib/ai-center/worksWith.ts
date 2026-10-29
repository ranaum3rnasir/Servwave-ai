// "Works with" for the agent detail modal (redesign D4, 29 Sep).
//
// Two kinds of chip, both drawn from what each agent's own copy in agents.ts already says:
//   - `agents`: the other animals its copy names (Spider names Falcon, Dolphin, Woodpecker and
//     Badger). A chip opens that animal. agents.test-style guard: worksWith.test.ts fails if a
//     teammate is listed that the copy never mentions.
//   - `modules`: the ServWave areas the agent works in (Leads, Estimates, Phone...). Never a
//     third-party product: these are ServWave's own module names, as the app's navigation labels
//     them.
//
// Kept in its own file rather than as a field on each AI_AGENTS entry so the catalog data and this
// list can change independently.

import type { LucideIcon } from 'lucide-react';
import { BarChart3, Boxes, ClipboardList, Repeat, ShoppingCart, Store, Tags, Workflow } from 'lucide-react';
import { coreNavIcons, essentialIcons } from '@/lib/servwave-icons';
import { AI_AGENTS, type AIAgent } from './agents';

export type FarmModule =
  | 'leads'
  | 'customers'
  | 'estimates'
  | 'jobs'
  | 'schedule'
  | 'invoices'
  | 'payments'
  | 'phone'
  | 'texts'
  | 'email'
  | 'tasks'
  | 'reports'
  | 'automations'
  | 'inventory'
  | 'purchaseOrders'
  | 'vendors'
  | 'priceBook'
  | 'marketing'
  | 'servicePlans';

/** Label + icon for each module, worded as the app's own navigation words it. */
export const FARM_MODULES: Record<FarmModule, { label: string; icon: LucideIcon }> = {
  leads: { label: 'Leads', icon: coreNavIcons.leads },
  customers: { label: 'Customers', icon: coreNavIcons.customers },
  estimates: { label: 'Estimates', icon: coreNavIcons.estimates },
  jobs: { label: 'Jobs', icon: coreNavIcons.jobs },
  schedule: { label: 'Schedule', icon: coreNavIcons.schedule },
  invoices: { label: 'Invoices', icon: coreNavIcons.invoices },
  payments: { label: 'Payments', icon: coreNavIcons.payments },
  phone: { label: 'Phone', icon: essentialIcons.calls },
  texts: { label: 'Text messages', icon: essentialIcons.messages },
  email: { label: 'Email', icon: essentialIcons.email },
  tasks: { label: 'Tasks', icon: ClipboardList },
  reports: { label: 'Reports', icon: BarChart3 },
  automations: { label: 'Automations', icon: Workflow },
  inventory: { label: 'Inventory', icon: Boxes },
  purchaseOrders: { label: 'Purchase orders', icon: ShoppingCart },
  vendors: { label: 'Vendors', icon: Store },
  priceBook: { label: 'Price book', icon: Tags },
  marketing: { label: 'Marketing', icon: coreNavIcons.marketing },
  servicePlans: { label: 'Service plans', icon: Repeat },
};

interface WorksWith {
  /** Ids of the other agents this agent's copy names, in the order the copy names them. */
  agents: string[];
  /** The ServWave modules it works in, most central first. */
  modules: FarmModule[];
}

export const AGENT_WORKS_WITH: Record<string, WorksWith> = {
  maya: { agents: [], modules: ['leads', 'customers', 'schedule', 'phone'] },
  sarah: { agents: [], modules: ['phone', 'leads', 'schedule', 'customers'] },
  david: { agents: [], modules: ['phone', 'reports'] },
  jordan: { agents: [], modules: ['estimates', 'texts', 'email', 'phone'] },
  emily: { agents: [], modules: ['customers', 'servicePlans', 'phone', 'texts'] },
  tyler: { agents: [], modules: ['marketing', 'customers', 'texts', 'email'] },
  olivia: { agents: [], modules: ['leads', 'customers', 'jobs'] },
  daniel: { agents: ['ethan'], modules: ['estimates', 'jobs', 'priceBook'] },
  iris: { agents: [], modules: ['phone', 'customers', 'jobs', 'tasks'] },
  audrey: { agents: [], modules: ['phone', 'reports'] },
  ruby: { agents: ['chloe'], modules: ['jobs', 'estimates', 'phone', 'reports'] },
  chloe: { agents: ['ruby'], modules: ['customers', 'texts', 'email'] },
  nathan: { agents: ['olivia', 'jordan', 'ruby'], modules: ['customers', 'marketing', 'texts', 'email'] },
  phoenix: { agents: ['tyler', 'chloe', 'ruby', 'nathan'], modules: ['marketing', 'reports', 'jobs'] },
  mike: { agents: [], modules: ['schedule', 'jobs'] },
  hannah: { agents: [], modules: ['inventory', 'purchaseOrders', 'vendors', 'jobs'] },
  carlos: { agents: [], modules: ['jobs', 'invoices', 'estimates'] },
  leo: { agents: [], modules: ['schedule', 'jobs'] },
  ben: { agents: [], modules: ['jobs'] },
  lucas: { agents: [], modules: ['automations', 'texts', 'email'] },
  ethan: { agents: [], modules: ['estimates', 'priceBook'] },
  marcus: { agents: [], modules: ['invoices', 'payments', 'texts', 'email'] },
  joseph: { agents: [], modules: ['invoices', 'purchaseOrders', 'jobs', 'vendors'] },
  rachel: { agents: [], modules: ['invoices', 'payments', 'reports'] },
  adam: { agents: ['joseph'], modules: ['jobs', 'vendors'] },
  naomi: { agents: [], modules: ['invoices', 'estimates', 'customers'] },
  jacob: { agents: ['ben', 'carlos'], modules: ['jobs'] },
  goose: { agents: ['ben'], modules: ['jobs', 'reports'] },
  spider: { agents: ['maya', 'sarah', 'jordan', 'marcus'], modules: ['leads', 'phone', 'texts'] },
  master: { agents: ['jordan', 'nathan', 'ruby', 'chloe'], modules: ['reports'] },
};

/** The agents and modules one agent works with, resolved for rendering. */
export function worksWithFor(agent: AIAgent): {
  agents: AIAgent[];
  modules: Array<{ key: FarmModule; label: string; icon: LucideIcon }>;
} {
  const entry = AGENT_WORKS_WITH[agent.id] ?? { agents: [], modules: [] };
  return {
    agents: entry.agents
      .map((id) => AI_AGENTS.find((a) => a.id === id))
      .filter((a): a is AIAgent => !!a),
    modules: entry.modules.map((key) => ({ key, ...FARM_MODULES[key] })),
  };
}
