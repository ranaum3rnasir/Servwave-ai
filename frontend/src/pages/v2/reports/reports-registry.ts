import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';

/**
 * slug -> the v2 report page component.
 *
 * The same 23 slugs as `pages/reports/reports-registry.ts`, pointed at this
 * module's rebuilds. Deliberately a SECOND registry rather than an import of
 * the legacy one: a registry maps a slug to a COMPONENT, and reusing the legacy
 * map would render legacy pages inside the v2 shell - the one thing this
 * migration exists not to do. The slug set is the contract between the two and
 * is asserted by `__tests__/reportsRegistry.test.ts`, so a report added to one
 * and forgotten in the other fails the build rather than silently falling
 * through to the generic report.
 */
export const reportComponents: Record<string, LazyExoticComponent<ComponentType>> = {
  'activity': lazy(() => import('./reports/ActivityReport')),
  'estimate-conversion': lazy(() => import('./reports/EstimateConversionReport')),
  'jobs': lazy(() => import('./reports/JobsReport')),
  'leads': lazy(() => import('./reports/LeadsReport')),
  'sales': lazy(() => import('./reports/SalesReport')),
  'job-statistics': lazy(() => import('./reports/JobStatisticsReport')),
  'tech-performance': lazy(() => import('./reports/TechPerformanceBoard')),
  'weekly-rep-diagnostic': lazy(() => import('./reports/WeeklyRepDiagnostic')),
  'job-profitability': lazy(() => import('./reports/JobProfitabilityReport')),
  'revenue': lazy(() => import('./reports/RevenueReport')),
  'unpaid-invoices': lazy(() => import('./reports/ArAgingReport')),
  'campaign-roi': lazy(() => import('./reports/CampaignRoiReport')),
  'communication-tracking': lazy(() => import('./reports/CommunicationTrackingReport')),
  'expenses': lazy(() => import('./reports/ExpensesReport')),
  'inventory-usage': lazy(() => import('./reports/InventoryUsageReport')),
  'invoices': lazy(() => import('./reports/InvoicesReport')),
  'items-and-services': lazy(() => import('./reports/ItemsServicesReport')),
  'call-tracking-summary': lazy(() => import('./reports/CallsReport')),
  'commissions': lazy(() => import('./reports/CommissionsReport')),
  'timesheets': lazy(() => import('./reports/TimesheetsReport')),
  'estimates': lazy(() => import('./reports/EstimatesReport')),
  'payments': lazy(() => import('./reports/PaymentsReport')),
  'service-plans': lazy(() => import('./reports/ServicePlansReport')),
};
