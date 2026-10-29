import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, BadgeCheck, CalendarClock, ShieldCheck, Users } from 'lucide-react';

import { findReport } from '@/lib/reports/report-catalog';
import { useServicePlans, type ServicePlan } from '@/lib/api/service-plans';

import { Button } from '@/ui-kit/components/ui/button';

import { ReportShell } from '../components/reportShell';
import { ReportKpis } from '../components/kpi';
import { preferV2Path } from '../../uiV2';

/**
 * Service Plans report - a five-tile health summary over `useServicePlans()`.
 *
 * The query and the roll-up are imported and unchanged. The "Open Service
 * Plans" action was a `<Link>` wearing button classes; it is now a kit `Button
 * asChild`, and its destination goes through `preferV2Path` so it lands on the
 * v2 workspace when Service Plans has one and the legacy page when it does not.
 */
export default function ServicePlansReport() {
  const report = findReport('service-plans')!;
  const { data: plans = [], isLoading } = useServicePlans();

  const k = useMemo(() => {
    let active = 0, drafts = 0, dueSoon = 0, expired = 0, revenue = 0;
    for (const p of plans as ServicePlan[]) {
      if (p.effective_status === 'ACTIVE') { active++; revenue += Number(p.contract_price); }
      if (p.status === 'DRAFT') drafts++;
      if (p.due_soon) dueSoon++;
      if (p.effective_status === 'EXPIRED') expired++;
    }
    return { active, drafts, dueSoon, expired, revenue };
  }, [plans]);

  return (
    <ReportShell
      report={report}
      subtitle="Recurring service-plan health - open the full workspace to manage plans and visits."
      actions={
        <Button asChild>
          <Link to={preferV2Path('/service-plans')}>
            Open Service Plans
            <ArrowUpRight />
          </Link>
        </Button>
      }
    >
      <ReportKpis
        loading={isLoading}
        items={[
          { icon: ShieldCheck, label: 'Active plans', value: k.active, tone: 'success' },
          { icon: BadgeCheck, label: 'Drafts', value: k.drafts, tone: 'neutral' },
          { icon: CalendarClock, label: 'Due soon', value: k.dueSoon, tone: 'warning' },
          { icon: AlertTriangle, label: 'Expired', value: k.expired, tone: 'danger' },
          { icon: Users, label: 'Contract revenue (active)', value: `$${k.revenue.toLocaleString('en-US')}`, tone: 'primary', emphasize: true },
        ]}
      />
    </ReportShell>
  );
}
