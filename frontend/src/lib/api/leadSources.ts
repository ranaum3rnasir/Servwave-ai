import { createOrgListApi } from './orgListRows';

export const leadSourceKeys = { all: ['lead-sources'] as const };
export const leadSourcesApi = createOrgListApi('/api/lead-sources');
