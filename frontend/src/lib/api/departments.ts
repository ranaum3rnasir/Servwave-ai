import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export interface Department {
  id: string;
  name: string;
  /** Display-only manager. Grants NO powers — purely informational. */
  head_id: string | null;
  head?: { id: string; first_name: string; last_name: string } | null;
  created_at: string;
}

export function useDepartments() {
  return useQuery<Department[]>({
    queryKey: ['departments'],
    queryFn: () => api.get('/api/departments').then((r) => r.data.departments),
  });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.post('/api/departments', { name }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
    onError: (err) =>
      toast({
        title: 'Could not add team',
        description: extractApiError(err, 'Failed to add team'),
        variant: 'destructive',
      }),
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, head_id }: { id: string; name?: string; head_id?: string | null }) =>
      api.patch(`/api/departments/${id}`, { name, head_id }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
    onError: (err) =>
      toast({
        title: 'Could not update team',
        description: extractApiError(err, 'Failed to update team'),
        variant: 'destructive',
      }),
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/departments/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departments'] }),
    onError: (err) =>
      toast({
        title: 'Could not delete team',
        description: extractApiError(err, 'Failed to delete team'),
        variant: 'destructive',
      }),
  });
}
