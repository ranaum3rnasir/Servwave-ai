import api from '@/lib/axios';

export type ColumnPref = { width?: number; visible?: boolean; manuallySized?: boolean }
export type TableViewConfig = { version: number; columns: Record<string, ColumnPref> }

export async function getTableView(tableKey: string): Promise<TableViewConfig | null> {
  const res = await api.get(`/api/me/table-views/${tableKey}`);
  const data = res.data as Partial<TableViewConfig>;
  if (!data || !('columns' in data)) return null;
  return data as TableViewConfig;
}

export async function putTableView(tableKey: string, config: TableViewConfig): Promise<void> {
  await api.put(`/api/me/table-views/${tableKey}`, config);
}
