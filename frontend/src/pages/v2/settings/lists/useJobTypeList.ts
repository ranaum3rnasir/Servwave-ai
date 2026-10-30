import { jobTypeKeys, jobTypesApi } from '@/lib/api/jobTypes';
import { JOB_TYPES_DEF, type ListController } from './listDefs';
import { useRowsList } from './useRowsList';

export function useJobTypeList(): ListController {
  return useRowsList(JOB_TYPES_DEF, jobTypeKeys.all, jobTypesApi);
}
