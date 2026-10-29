export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function parsePagination(query: {
  page?: string;
  limit?: string;
}): PaginationParams {
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '25', 10) || 25));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

import type { Response } from 'express';
import type { SortFieldMap } from './sortFields';

export type OrderByList = Record<string, 'asc' | 'desc'>[];

export type SortResult =
  | { ok: true; orderBy: OrderByList }
  | { ok: false; field: string; allowed: string[] };

/**
 * SRVW-89 - resolves a client-supplied `sortBy` column id through `fieldMap` into a Prisma
 * `orderBy` array. Returns a discriminated result so TypeScript forces every caller to check
 * `.ok` before reading `orderBy` - no call site can silently skip the unmappable-field case.
 *
 * `defaultField` deliberately bypasses `fieldMap`: it is the server's own fallback ordering,
 * not a client-supplied token, so it is never validated against the map.
 *
 * An unmapped `sortBy` returns `ok: false` rather than silently falling back to `defaultField` -
 * every id a shipped column can emit has an entry in `fieldMap`.
 */
export function parseSortParams(
  query: { sortBy?: string; sortDir?: string },
  fieldMap: SortFieldMap,
  defaultField = 'created_at',
  defaultDir: 'asc' | 'desc' = 'desc'
): SortResult {
  const dir = query.sortDir === 'asc' ? 'asc' : query.sortDir === 'desc' ? 'desc' : defaultDir;

  if (!query.sortBy) {
    return { ok: true, orderBy: [{ [defaultField]: dir }] };
  }

  const fields = fieldMap[query.sortBy];
  if (!fields) {
    return { ok: false, field: query.sortBy, allowed: Object.keys(fieldMap) };
  }

  return { ok: true, orderBy: fields.map((f) => ({ [f]: dir })) };
}

/**
 * SRVW-89 - writes the standard 400 for an unmappable `sortBy`, so the wire contract
 * (`error`, `code: 'INVALID_SORT_FIELD'`, `field`, `allowed`) lives in one place instead
 * of being copy-pasted into every `parseSortParams` caller.
 */
export function respondInvalidSort(res: Response, sort: Extract<SortResult, { ok: false }>): void {
  res.status(400).json({
    error: `Unknown sort field: ${sort.field}`,
    code: 'INVALID_SORT_FIELD',
    field: sort.field,
    allowed: sort.allowed,
  });
}

export function buildPaginationMeta(
  total: number,
  params: PaginationParams
): PaginationMeta {
  return {
    page: params.page,
    limit: params.limit,
    total,
    totalPages: Math.ceil(total / params.limit),
  };
}
