import api from '@/lib/axios';

/**
 * The two Lists-page lists that live as rows: Job types (`/api/job-types`) and Lead/Customer sources
 * (`/api/lead-sources`). Both answer the same shapes, so one factory serves both (V7-04a).
 */
export interface OrgListRow {
  id: string;
  name: string;
  sort_order: number;
  archived: boolean;
  /** Records carrying the name (jobs and leads for a job type, leads for a source). */
  used_count: number;
}

export interface OrgListResponse {
  items: OrgListRow[];
  counts: { active: number; archived: number };
}

export function createOrgListApi(base: string) {
  return {
    list: () => api.get(base).then((r) => r.data as OrgListResponse),
    create: (name: string) => api.post(base, { name }).then((r) => r.data.item as OrgListRow),
    rename: (id: string, name: string) => api.patch(`${base}/${id}`, { name }).then((r) => r.data.item as OrgListRow),
    archive: (id: string) => api.post(`${base}/${id}/archive`).then((r) => r.data.item as OrgListRow),
    unarchive: (id: string) => api.post(`${base}/${id}/unarchive`).then((r) => r.data.item as OrgListRow),
    /** Only while the row is unused; it exists so Undo of a Create can take the new row back out. */
    remove: (id: string) => api.delete(`${base}/${id}`).then(() => undefined),
    /** The body must name every ACTIVE row exactly once, in the order to offer them in. */
    reorder: (orderedIds: string[]) => api.post(`${base}/reorder`, { ordered_ids: orderedIds }).then(() => undefined),
  };
}

export type OrgListApi = ReturnType<typeof createOrgListApi>;
