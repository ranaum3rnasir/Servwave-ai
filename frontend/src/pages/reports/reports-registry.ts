import { lazy } from 'react';
import type { LazyExoticComponent, ComponentType } from 'react';

/**
 * Maps a report slug → its built page component. Reports listed here render
 * live; any slug NOT listed falls back to the "coming soon" stub. Add an entry
 * as each report is built out.
 */
export const reportComponents: Record<string, LazyExoticComponent<ComponentType>> = {
  'activity': lazy(() => import('./ActivityReport')),
  'estimate-conversion': lazy(() => import('./EstimateConversionReport')),
  'jobs': lazy(() => import('./JobsReport')),
  'leads': lazy(() => import('./LeadsReport')),
  'sales': lazy(() => import('./SalesReport')),
  'job-statistics': lazy(() => import('./JobStatisticsReport')),
  'tech-performance': lazy(() => import('./TechPerformanceBoard')),
  'weekly-rep-diagnostic': lazy(() => import('./WeeklyRepDiagnostic')),
  'job-profitability': lazy(() => import('./JobProfitabilityReport')),
  'revenue': lazy(() => import('./RevenueReport')),
  'unpaid-invoices': lazy(() => import('./ArAgingReport')),
  'campaign-roi': lazy(() => import('./CampaignRoiReport')),
  'communication-tracking': lazy(() => import('./CommunicationTrackingReport')),
  'expenses': lazy(() => import('./ExpensesReport')),
  'inventory-usage': lazy(() => import('./InventoryUsageReport')),
  'invoices': lazy(() => import('./InvoicesReport')),
  'items-and-services': lazy(() => import('./ItemsServicesReport')),
  'call-tracking-summary': lazy(() => import('./CallsReport')),
  'commissions': lazy(() => import('./CommissionsReport')),
  'timesheets': lazy(() => import('./TimesheetsReport')),
  'estimates': lazy(() => import('./EstimatesReport')),
  'payments': lazy(() => import('./PaymentsReport')),
  'service-plans': lazy(() => import('./ServicePlansReport')),
};
