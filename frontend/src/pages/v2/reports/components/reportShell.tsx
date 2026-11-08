import type { ReactNode } from 'react';

import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Badge } from '@/ui-kit/components/ui/badge';
import type { ReportDef } from '@/lib/reports/report-catalog';

import { BackLink } from '../../_shared/backLink';
import { v2Path } from '../../uiV2';
import { useRecordVisit } from '../../pageBreadcrumbs';

/**
 * The chrome every built report sits in.
 *
 * The legacy shell hand-built a back link, a round icon medallion, a code chip
 * and an `<h1>`, plus an actions slot. On the kit that is the kit's own
 * `PageHeader`: the title, the description and the right-hand actions column
 * are its three slots, and the S-code becomes a `Badge` inside the title.
 *
 * The icon medallion is dropped. It repeated the icon already on the card the
 * reader clicked to get here, and `PageHeader` has no icon slot for the same
 * reason `StatCard` has none - a glyph beside a title it already names carries
 * nothing. `report.icon` is still read by the landing card and the stub page.
 *
 * "Back to Reports" points at `v2Path('/reports')`, which is `/reports` -
 * `v2Path` is a no-op shim kept for its call sites (see `uiV2.ts`). It rides in
 * `PageHeader`'s own
 * `back` slot rather than as a link hand-placed above the header, so its
 * offset and the gap under it are the header's decision and match the other
 * pages that go back somewhere.
 */
export function ReportShell({
  report, actions, subtitle, children,
}: {
  report: ReportDef;
  actions?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  // Every report page routes through this shell, so one call here names all
  // thirty of them in the trail by their own title rather than as "Reports".
  useRecordVisit('reports', report.label);

  return (
    <div>
      <PageHeader
        back={<BackLink to={v2Path('/reports')}>Back to Reports</BackLink>}
        title={
          <span className="flex flex-wrap items-center gap-2">
            {report.code && <Badge variant="softNeutral" size="sm" className="tabular-nums">{report.code}</Badge>}
            {report.label}
          </span>
        }
        description={subtitle}
        actions={actions}
      />

      <div className="space-y-4">{children}</div>
    </div>
  );
}
