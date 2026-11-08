import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Users, BadgeCheck, ShieldCheck, CalendarClock, AlertTriangle } from 'lucide-react';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { KpiStrip } from '@/components/data/KpiStrip';
import { useServicePlans, type ServicePlan } from '@/lib/api/service-plans';

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
    <ReportShell report={report} subtitle="Recurring service-plan health — open the full workspace to manage plans and visits."
      actions={<Link to="/service-plans" className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-fill hover:opacity-90">Open Service Plans <ArrowUpRight className="h-4 w-4" /></Link>}>
      <KpiStrip loading={isLoading} items={[
        { icon: ShieldCheck, label: 'Active plans', value: k.active, tone: 'success' },
        { icon: BadgeCheck, label: 'Drafts', value: k.drafts, tone: 'neutral' },
        { icon: CalendarClock, label: 'Due soon', value: k.dueSoon, tone: 'warning' },
        { icon: AlertTriangle, label: 'Expired', value: k.expired, tone: 'danger' },
        { icon: Users, label: 'Contract revenue (active)', value: `$${k.revenue.toLocaleString('en-US')}`, tone: 'primary', emphasize: true },
      ]} />
    </ReportShell>
  );
}
