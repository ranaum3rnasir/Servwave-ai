import { listHandlers, listNameBodySchema, listReorderBodySchema, JOB_TYPE_KIND } from '../lib/org-list-rows';

/**
 * Job types as rows (V7-03). Everything lives in lib/org-list-rows.ts, shared with the sibling list; this file only names
 * the list. Gated `update Organization` in the router, reads included (the forms read the lists through the org record).
 */
const handlers = listHandlers(JOB_TYPE_KIND);

export const createSchema = listNameBodySchema;
export const renameSchema = listNameBodySchema;
export const reorderSchema = listReorderBodySchema;
export const { list, create, rename, archive, unarchive, remove, reorder } = handlers;
