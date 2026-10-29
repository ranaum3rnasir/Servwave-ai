import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

export type CustomFieldEntityType = 'LEAD' | 'JOB' | 'CUSTOMER' | 'PRICE_BOOK_ITEM';

export interface CustomFieldDefinition {
  id: string;
  key: string;
  label: string;
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'CHECKBOX';
  entity_types: CustomFieldEntityType[];
  options: unknown[];
  required: boolean;
  sort_order: number;
  archived_at: string | null;
}

export type CustomFieldDefinitionInput = {
  key: string;
  label: string;
  type: 'TEXT';
  entity_types: CustomFieldEntityType[];
};

export function useCustomFieldDefinitions(entityType?: CustomFieldEntityType) {
  return useQuery<CustomFieldDefinition[]>({
    queryKey: ['custom-field-definitions', entityType ?? 'all'],
    queryFn: () =>
      api
        .get('/api/custom-field-definitions', entityType ? { params: { entity_type: entityType } } : undefined)
        .then((r) => r.data.custom_field_definitions),
  });
}

export function useCreateCustomFieldDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: CustomFieldDefinitionInput) =>
      api.post('/api/custom-field-definitions', d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-field-definitions'] }),
  });
}

/** Label and entity scope only - `key` and `type` are immutable once values exist. */
export type CustomFieldDefinitionPatch = {
  label?: string;
  entity_types?: CustomFieldEntityType[];
};

export function useUpdateCustomFieldDefinition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: CustomFieldDefinitionPatch & { id: string }) =>
      api.patch(`/api/custom-field-definitions/${id}`, patch).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['custom-field-definitions'] }),
  });
}
