import { lazy, Suspense } from 'react';
import { useParams } from 'react-router-dom';
import { reportComponents } from './reports-registry';
import { findReport, canShowReport } from '@/lib/reports/report-catalog';
import { useIsDemoOrg } from '@/lib/useIsDemoOrg';
import { useHasFeature } from '@/lib/entitlements';
import GenericReport from './GenericReport';
import ReportStubPage from './ReportStubPage';

/**
 * Dispatcher for /reports/:slug:
 *  1. a bespoke report component (registry) if one is built,
 *  2. otherwise the generic data-rich report for any known catalog slug,
 *  3. otherwise the "not found" stub.
 *
 * Org gate: a real (non-demo) org hitting a not-yet-backed report by direct URL
 * gets the "coming soon" stub instead of fabricated data — the landing grid
 * already hides these cards, this defends the direct-navigation path.
 */
export default function ReportRoute() {
  const { slug } = useParams<{ slug: string }>();
  const isDemoOrg = useIsDemoOrg();
  const hasFeature = useHasFeature();

  const report = findReport(slug);
  if (report && !canShowReport(report, isDemoOrg, hasFeature)) {
    // canShowReport already ruled out demo orgs and a missing report here, so the only
    // remaining reason it can be false is the declared-feature check.
    const notInPlan = !!report.feature && !hasFeature(report.feature);
    return <ReportStubPage reason={notInPlan ? 'not-in-plan' : 'coming-soon'} />;
  }

  const Built = slug ? reportComponents[slug] : undefined;

  if (Built) {
    return (
      <Suspense fallback={<div className="p-6 text-sm text-text-secondary">Loading report…</div>}>
        <Built />
      </Suspense>
    );
  }

  if (report) return <GenericReport report={report} />;

  return <ReportStubPage />;
}
