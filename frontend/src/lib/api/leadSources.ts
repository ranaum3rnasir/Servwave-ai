import { createOrgListApi } from '@/lib/api/shared/orgListRows';

export const leadSourceKeys = { all: ['lead-sources'] as const };
export const leadSourcesApi = createOrgListApi('/api/lead-sources');
