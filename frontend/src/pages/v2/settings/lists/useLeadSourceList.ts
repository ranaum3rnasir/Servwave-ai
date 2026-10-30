import { leadSourceKeys, leadSourcesApi } from '@/lib/api/leadSources';
import { LEAD_SOURCES_DEF, type ListController } from './listDefs';
import { useRowsList } from './useRowsList';

export function useLeadSourceList(): ListController {
  return useRowsList(LEAD_SOURCES_DEF, leadSourceKeys.all, leadSourcesApi);
}
