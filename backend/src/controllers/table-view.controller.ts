import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';

// ─── Constants ────────────────────────────────────────

const ALLOWED_TABLE_KEYS = ['customers', 'leads', 'estimates', 'jobs', 'invoices'] as const;
type TableKey = (typeof ALLOWED_TABLE_KEYS)[number];

const WIDTH_MIN = 64;
const WIDTH_MAX = 1200;

// ─── Zod Schema ───────────────────────────────────────

export const tableViewConfigSchema = z.object({
  version: z.number().int(),
  columns: z.record(
    z.object({
      width: z.number().optional(),
      visible: z.boolean().optional(),
      manuallySized: z.boolean().optional(),
    })
  ),
});

// ─── Helpers ──────────────────────────────────────────

function clampWidths(config: z.infer<typeof tableViewConfigSchema>): z.infer<typeof tableViewConfigSchema> {
  const clampedColumns: typeof config.columns = {};
  for (const [colKey, colVal] of Object.entries(config.columns)) {
    if (colVal.width !== undefined) {
      clampedColumns[colKey] = {
        ...colVal,
        width: Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, colVal.width)),
      };
    } else {
      clampedColumns[colKey] = colVal;
    }
  }
  return { ...config, columns: clampedColumns };
}

function validateTableKey(tableKey: string, res: Response): tableKey is TableKey {
  if (!(ALLOWED_TABLE_KEYS as readonly string[]).includes(tableKey)) {
    res.status(400).json({ error: 'Invalid table key' });
    return false;
  }
  return true;
}

// ─── Handlers ────────────────────────────────────────

export async function getView(req: Request, res: Response): Promise<void> {
  const tableKey = req.params.tableKey as string;
  if (!validateTableKey(tableKey, res)) return;

  const userId = req.user!.id;

  const pref = await prisma.userTablePreference.findFirst({
    where: { user_id: userId, table_key: tableKey },
  });

  if (!pref) {
    res.json({});
    return;
  }

  res.json(pref.config);
}

export async function upsertView(req: Request, res: Response): Promise<void> {
  const tableKey = req.params.tableKey as string;
  if (!validateTableKey(tableKey, res)) return;

  const userId = req.user!.id;

  // Validate body shape — req.body already parsed by validate() middleware
  const config = clampWidths(req.body as z.infer<typeof tableViewConfigSchema>);

  const pref = await prisma.userTablePreference.upsert({
    where: { user_id_table_key: { user_id: userId, table_key: tableKey } },
    create: { user_id: userId, table_key: tableKey, config },
    update: { config },
  });

  res.json(pref.config);
}
