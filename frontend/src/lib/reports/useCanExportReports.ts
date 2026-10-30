import { useAppAbility } from '@/contexts/AbilityContext';

/**
 * Whether the person may take report data out (the Export reports switch, which compiles into `export Report`).
 * Every report's download button reads this, so Access Reports alone opens a report without its download.
 */
export function useCanExportReports(): boolean {
  return useAppAbility().can('export', 'Report');
}
