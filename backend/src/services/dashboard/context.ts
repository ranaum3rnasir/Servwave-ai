import type { Request } from 'express';
import { tenantWhere } from '../../lib/tenant';
import { scopeWhereForReq } from '../../lib/permissions/enforce';
import { ownRecordsWhere } from '../../lib/permissions/ownSet';
import { canSeeCompanyFigures } from '../../lib/permissions/enforce';
import { resolveSwitches } from '../../lib/permissions/switches/store';
import type { ScopedSubject } from '../../lib/permissions/switches/catalog';
import { getRequestOrgTimezone } from '../../lib/timezone';
import { orgTodayStart } from '../../lib/orgDayRange';
import { findTile, tileModeAndLabel, type SwitchValues, type TileMode } from '../../lib/dashboard/tileCatalog';

export type Where = Record<string, unknown>;

/**
 * `base` with every non-empty scope fragment ANDed on, never spread: a scope can carry an `OR` of its own, and
 * under AND it can neither be clobbered by nor clobber a key the query already owns.
 */
export function withScope<W extends object>(base: W, ...scopes: Where[]): W {
  const required = scopes.filter((s) => Object.keys(s).length > 0);
  if (required.length === 0) return base;
  const and = (base as Where).AND;
  const existing = Array.isArray(and) ? (and as unknown[]) : and !== undefined ? [and] : [];
  return { ...base, AND: [...existing, ...required] } as W;
}

/** The dashboard's date arithmetic, fixed once per request so every tile reads the same instants. */
export interface DashBounds {
  now: Date;
  todayStart: Date;
  todayEnd: Date;
  yesterdayStart: Date;
  yesterdayEnd: Date;
  monthStart: Date;
  lastMonthStart: Date;
  lastMonthEnd: Date;
  thirtyDaysAgo: Date;
  sixtyDaysAgo: Date;
  weekStart: Date;
  weekEnd: Date;
  scheduleDateStart: Date;
  scheduleDateEnd: Date;
  monthCount: number;
  chartPeriodStart: Date;
  /** The instant the org's day began: the single boundary every overdue reading uses. */
  overdueBefore: Date;
  /** The 48-hour attention item (customer not told) looks this far ahead of a visit. */
  attentionHorizon: Date;
}

function buildBounds(req: Request, now: Date, timeZone: string): DashBounds {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayEnd = new Date(todayEnd);
  yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
  const thirtyDaysAgo = new Date(now);
  thirtyDaysAgo.setDate(now.getDate() - 30);
  const sixtyDaysAgo = new Date(now);
  sixtyDaysAgo.setDate(now.getDate() - 60);
  // Current week (Sunday to Saturday) for the "Jobs This Week" KPI
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - todayStart.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  // Schedule date (query param, default today)
  const scheduleDateStr = req.query.date as string | undefined;
  let scheduleDate = new Date(now);
  if (scheduleDateStr && /^\d{4}-\d{2}-\d{2}$/.test(scheduleDateStr)) scheduleDate = new Date(scheduleDateStr + 'T00:00:00');
  const scheduleDateStart = new Date(scheduleDate);
  scheduleDateStart.setHours(0, 0, 0, 0);
  const scheduleDateEnd = new Date(scheduleDate);
  scheduleDateEnd.setHours(23, 59, 59, 999);

  // Chart period
  const periodStr = (req.query.period as string) || '6M';
  const monthCount = periodStr === '3M' ? 3 : periodStr === '12M' ? 12 : 6;

  return {
    now,
    todayStart,
    todayEnd,
    yesterdayStart,
    yesterdayEnd,
    monthStart: new Date(now.getFullYear(), now.getMonth(), 1),
    lastMonthStart: new Date(now.getFullYear(), now.getMonth() - 1, 1),
    lastMonthEnd: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
    thirtyDaysAgo,
    sixtyDaysAgo,
    weekStart,
    weekEnd,
    scheduleDateStart,
    scheduleDateEnd,
    monthCount,
    chartPeriodStart: new Date(now.getFullYear(), now.getMonth() - monthCount + 1, 1),
    overdueBefore: orgTodayStart(timeZone, now),
    attentionHorizon: new Date(now.getTime() + 48 * 3_600_000),
  };
}

/**
 * Everything a tile needs to answer for the person asking: who they are, their switches, the time, and the row
 * scopes. Row scopes come from the access resolver (the same fragments the list pages use), never built here, and are
 * asked for on demand so a tile that is not computed costs nothing.
 */
export interface DashContext {
  req: Request;
  userId: string;
  orgWhere: { organization_id: string };
  timeZone: string;
  b: DashBounds;
  /** Optional department filter on Today's Schedule (UUID). */
  scheduleDepartmentId: string | undefined;
  values: SwitchValues;
  /** See company figures: whether money is summed over the company's records (within the tile's scope) or the person's own. */
  sees: boolean;
  /** True when the person holds the switch (a View switch, mostly). */
  has(switchKey: string): boolean;
  /** Computed once per request however many tiles ask: a query several tiles share runs once. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
  /** The mode (company, scope, own) the server tells the page this tile is in. */
  modeOf(tileId: string): TileMode;
  /** The records the person can open for a kind of record: the list pages' own row scope (counts follow it). */
  scope(subject: ScopedSubject): Promise<Where>;
  /** The records a figure of money is summed over: the row scope with See company figures, else "Yours". */
  money(subject: ScopedSubject): Promise<Where>;
}

export async function buildContext(req: Request): Promise<DashContext> {
  const user = req.user!;
  const timeZone = await getRequestOrgTimezone(req);
  const now = new Date();
  const values = await resolveSwitches(user);
  const sees = canSeeCompanyFigures(req);

  const rawDepartmentId = req.query.department_id;
  const scheduleDepartmentId =
    typeof rawDepartmentId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawDepartmentId)
      ? rawDepartmentId
      : undefined;

  const memos = new Map<string, Promise<unknown>>();
  const memo = <T,>(key: string, load: () => Promise<T>): Promise<T> => {
    if (!memos.has(key)) memos.set(key, load());
    return memos.get(key) as Promise<T>;
  };

  return {
    req,
    userId: user.id,
    orgWhere: tenantWhere(req),
    timeZone,
    b: buildBounds(req, now, timeZone),
    scheduleDepartmentId,
    values,
    sees,
    has: (key) => values[key] === true,
    memo,
    modeOf: (tileId) => tileModeAndLabel(findTile(tileId)!, values).mode,
    scope: (subject) => memo(`scope:${subject}`, () => scopeWhereForReq(req, subject)),
    money: (subject) =>
      memo(`money:${subject}`, async () => (sees ? scopeWhereForReq(req, subject) : ownRecordsWhere(subject, user.id))),
  };
}
