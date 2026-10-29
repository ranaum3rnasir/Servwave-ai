import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { LEADS, type Lead } from './leads-fixtures';

// Live DTO from GET /api/reports/leads — dates arrive as ISO strings and are
// rehydrated into Date objects so the live rows match the demo `Lead` shape the
// report renders (its date fields are Date instances).
interface LeadDto {
  leadNumber: number;
  client: string;
  email: string;
  phone: string;
  address: string;
  status: Lead['status'];
  source: string;
  assigned: string;
  createdBy: string;
  tags: string[];
  jobType: string;
  estimates: number;
  createdAt: string;
  scheduledAt: string | null;
  convertedAt: string | null;
  value: number;
}

function toLead(d: LeadDto): Lead {
  return {
    ...d,
    createdAt: new Date(d.createdAt),
    // scheduledAt is non-null in the demo shape; fall back to createdAt if the
    // lead has no schedule yet so date filtering/formatting stays well-defined.
    scheduledAt: d.scheduledAt ? new Date(d.scheduledAt) : new Date(d.createdAt),
    convertedAt: d.convertedAt ? new Date(d.convertedAt) : null,
  };
}

/**
 * Leads for the Leads report.
 *  • demo org → the deterministic sample leads (renders identically to today).
 *  • real org → GET /api/reports/leads (tenant-scoped leads + customer + linked
 *    estimate value, status mapped server-side), rehydrated to the `Lead` shape.
 */
export function useLeadsReport(isDemo: boolean): { leads: Lead[]; isLoading: boolean } {
  const live = useQuery({
    queryKey: ['report-leads'],
    queryFn: async () => {
      const { data } = await api.get('/api/reports/leads');
      return ((data.leads ?? []) as LeadDto[]).map(toLead);
    },
    staleTime: 60_000,
    enabled: !isDemo,
  });

  if (isDemo) return { leads: LEADS, isLoading: false };
  return { leads: live.data ?? [], isLoading: live.isLoading };
}
