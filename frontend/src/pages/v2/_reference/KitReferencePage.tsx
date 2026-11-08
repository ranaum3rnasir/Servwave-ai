import KitJobsPage from '@/ui-kit/_reference/jobs/jobsPage';

/**
 * Renders the CRM UI kit's own jobs page against its bundled fixture data.
 *
 * This is the Phase 0 acceptance surface: the kit authors describe
 * `jobsPagePreview.html` as the behavioural spec, so this route exists to diff
 * the compiled components against it. It reaches no API and is not a product
 * page - the real /v2/jobs arrives with module 5.
 */
export default function KitReferencePage() {
  return <KitJobsPage />;
}
