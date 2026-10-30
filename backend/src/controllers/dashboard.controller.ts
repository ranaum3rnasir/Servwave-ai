import { Request, Response } from 'express';
import { logger } from '../lib/logger';
import { canSeeCompanyFigures } from '../lib/permissions/enforce';
import { redactDashboardCompanyFigures } from '../lib/permissions/companyFigures';
import { buildDashboard } from '../services/dashboard';
import { carryOverMyLayout, readMyLayout, resetMyLayout, saveMyLayout } from '../services/dashboard/layout';
import { UnavailableTileError, type LayoutEntry } from '../lib/dashboard/layout';

/**
 * GET /api/dashboard - the signed-in person's own dashboard (PRD 9). Open to everyone signed in: no switch gates it.
 * The answer holds the tiles the person's switches make eligible (each with its category, mode and label) and each
 * tile's data keyed by tile id, every figure drawn from the records the person can open. A person whose switches
 * unlock nothing gets an empty list, not a refusal.
 *
 * Query: `period` (chart months), `date` (schedule day), `department_id` (schedule filter) as before, and `tiles`
 * (comma-separated tile ids) to ask for some tiles only; an id the person may not have is not returned. `shown=1` is the
 * home page's read: every eligible tile is listed (the picker needs them) but only the tiles the person's layout shows are
 * computed. A tile whose loader failed or ran out of time comes back as `{ error: true }`; the rest of the answer stands.
 */
export async function getDashboard(req: Request, res: Response) {
  try {
    const rawTiles = req.query.tiles;
    const only = typeof rawTiles === 'string' ? rawTiles.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
    const answer = await buildDashboard(req, { only, shown: req.query.shown === '1' });
    // M4 runs last, on the finished answer, as a backstop: whatever a tile above built, company-only figures cannot
    // reach a person without See company figures.
    res.json(canSeeCompanyFigures(req) ? answer : redactDashboardCompanyFigures(answer));
  } catch (err) {
    logger.error('Error fetching dashboard:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/dashboard/layout - the signed-in person's own home-page layout (PRD 9). Open to everyone signed in; it names
 * no person, so nobody reads another's. A person with no saved layout is sent the default of the role they are based
 * on. Answers `{ layout, saved }`: the tiles to draw in order, and whether a layout is saved for the person.
 */
export async function getMyLayout(req: Request, res: Response) {
  try {
    res.json(await readMyLayout(req.user!));
  } catch (err) {
    logger.error('Error fetching dashboard layout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PUT /api/dashboard/layout - saves the whole layout for the signed-in person only; answers as the read does. A save
 * that would show a tile the person cannot have is refused with 409 and stores nothing (PRD 9, S09.7).
 */
export async function putMyLayout(req: Request, res: Response) {
  try {
    res.json(await saveMyLayout(req.user!, (req.body as { layout: LayoutEntry[] }).layout));
  } catch (err) {
    if (err instanceof UnavailableTileError) {
      res.status(409).json({ error: "That tile isn't available with your access.", code: 'TILE_NOT_AVAILABLE' });
      return;
    }
    logger.error('Error saving dashboard layout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/dashboard/layout/reset - replaces the signed-in person's saved layout with the default of the role they are
 * based on (PRD 9, S09.6) and answers as the read does. It names no person and needs nothing beyond being signed in.
 */
export async function postResetLayout(req: Request, res: Response) {
  try {
    res.json(await resetMyLayout(req.user!));
  } catch (err) {
    logger.error('Error resetting dashboard layout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/dashboard/layout/carry-over - the one-time move of the layout a person kept in their browser (PRD 9, S09.5).
 * Saves it only if the signed-in person has no saved layout; otherwise their saved layout wins and is what comes back.
 */
export async function postCarryOverLayout(req: Request, res: Response) {
  try {
    res.json(await carryOverMyLayout(req.user!, (req.body as { layout: LayoutEntry[] }).layout));
  } catch (err) {
    logger.error('Error carrying over dashboard layout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
