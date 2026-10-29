import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { logAudit } from '../lib/audit';

// ─── Zod Schemas ───────────────────────────────────────
//
// The frontend seam (frontend/src/lib/api/communication.ts) is the API contract.
// Components are typed against the `_mock` shapes (camelCase keys, nested Json
// structures), so request bodies arrive camelCase and responses must be mapped
// back to camelCase. The Prisma rows are snake_case; the mappers below bridge
// the two. Nested structures (FlowNode[], CallGroupMember[], steps/dialogue/
// transcript) are stored verbatim in Json columns and passed through unchanged.

// ── Call flows ──
// FlowNode / ForwardTarget / MenuOption are nested editor structures the canvas
// owns; we validate them as passthrough objects and persist them verbatim.
const forwardTargetSchema = z.any();
const flowNodeSchema = z.any();

export const createCallFlowSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  structure: z.enum(['basic', 'voice_menu']),
  record: z.boolean().optional(),
  status: z.enum(['active', 'draft']).optional(),
  hoursMode: z.enum(['always', 'schedule']).optional(),
  openNodes: z.array(flowNodeSchema).optional(),
  closedNodes: z.array(flowNodeSchema).optional(),
});

export const updateCallFlowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  structure: z.enum(['basic', 'voice_menu']).optional(),
  record: z.boolean().optional(),
  status: z.enum(['active', 'draft']).optional(),
  hoursMode: z.enum(['always', 'schedule']).optional(),
  openNodes: z.array(flowNodeSchema).optional(),
  closedNodes: z.array(flowNodeSchema).optional(),
});

// ── Call groups ──
const callGroupMemberSchema = z.object({
  personId: z.string(),
  name: z.string(),
  device: z.enum(['cell', 'softphone']),
});

export const createCallGroupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  ring: z.enum(['all', 'round_robin']),
  members: z.array(callGroupMemberSchema).optional(),
});

export const updateCallGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  ring: z.enum(['all', 'round_robin']).optional(),
  members: z.array(callGroupMemberSchema).optional(),
});

// ─── Mappers (snake_case Prisma row → camelCase mock shape) ──────────

function toCallFlow(row: any) {
  return {
    id: row.id,
    name: row.name,
    structure: row.structure,
    record: row.record,
    status: row.status,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    hoursMode: row.hours_mode,
    openNodes: row.open_nodes ?? [],
    closedNodes: row.closed_nodes ?? [],
  };
}

function toCallGroup(row: any) {
  return {
    id: row.id,
    name: row.name,
    ring: row.ring,
    members: row.members ?? [],
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function toTrainingScenario(row: any) {
  return {
    // The mock uses slug-style ids ("trn_book_new"); prefer the stored slug,
    // falling back to the UUID for rows that have none.
    id: row.slug ?? row.id,
    roleId: row.role_id,
    title: row.title,
    difficulty: row.difficulty,
    durationMin: row.duration_min,
    scriptFocus: row.script_focus,
    trainerName: row.trainer_name,
    persona: row.persona,
    steps: row.steps ?? [],
    dialogue: row.dialogue ?? [],
  };
}

function toTrainingSession(row: any) {
  return {
    id: row.id,
    traineeName: row.trainee_name,
    traineeRole: row.trainee_role,
    roleId: row.role_id,
    scenarioId: row.scenario_slug ?? row.scenario_id,
    scenarioTitle: row.scenario_title,
    difficulty: row.difficulty,
    trainerName: row.trainer_name,
    score: row.score,
    outcome: row.outcome,
    durationSec: row.duration_sec,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    hasRecording: row.has_recording,
    coachingNote: row.coaching_note,
    transcript: row.transcript ?? undefined,
  };
}

// ─── Call-flow handlers ────────────────────────────────

export async function listCallFlows(req: Request, res: Response) {
  try {
    const flows = await prisma.callFlow.findMany({
      where: tenantWhere(req),
      orderBy: [{ updated_at: 'desc' }],
    });

    res.json({ callFlows: flows.map(toCallFlow) });
  } catch (err) {
    logger.error('Failed to list call flows:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getCallFlow(req: Request, res: Response) {
  try {
    const flow = await prisma.callFlow.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!flow) {
      res.status(404).json({ error: 'Call flow not found' });
      return;
    }

    res.json({ callFlow: toCallFlow(flow) });
  } catch (err) {
    logger.error('Failed to get call flow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createCallFlow(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    const flow = await prisma.callFlow.create({
      data: {
        name: req.body.name,
        structure: req.body.structure,
        record: req.body.record ?? false,
        status: req.body.status ?? 'draft',
        hours_mode: req.body.hoursMode ?? 'always',
        open_nodes: req.body.openNodes ?? [],
        closed_nodes: req.body.closedNodes ?? [],
        organization_id: orgId,
      },
    });

    void logAudit({ req, action: 'callflow.created', resourceType: 'CallFlow', resourceId: flow.id });
    res.status(201).json({ callFlow: toCallFlow(flow) });
  } catch (err) {
    logger.error('Failed to create call flow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateCallFlow(req: Request, res: Response) {
  try {
    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.structure !== undefined) data.structure = req.body.structure;
    if (req.body.record !== undefined) data.record = req.body.record;
    if (req.body.status !== undefined) data.status = req.body.status;
    if (req.body.hoursMode !== undefined) data.hours_mode = req.body.hoursMode;
    if (req.body.openNodes !== undefined) data.open_nodes = req.body.openNodes;
    if (req.body.closedNodes !== undefined) data.closed_nodes = req.body.closedNodes;

    // updateMany with id+org filter is atomic (single query) — no TOCTOU window.
    const updateResult = await prisma.callFlow.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Call flow not found' });
      return;
    }
    const flow = await prisma.callFlow.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({ req, action: 'callflow.updated', resourceType: 'CallFlow', resourceId: req.params.id as string });
    res.json({ callFlow: toCallFlow(flow) });
  } catch (err) {
    logger.error('Failed to update call flow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteCallFlow(req: Request, res: Response) {
  try {
    // deleteMany with id+org filter is atomic — no TOCTOU window.
    const result = await prisma.callFlow.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Call flow not found' });
      return;
    }

    void logAudit({ req, action: 'callflow.deleted', resourceType: 'CallFlow', resourceId: req.params.id as string });
    res.json({ message: 'Call flow deleted' });
  } catch (err) {
    logger.error('Failed to delete call flow:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Call-group handlers ───────────────────────────────

export async function listCallGroups(req: Request, res: Response) {
  try {
    const groups = await prisma.callGroup.findMany({
      where: tenantWhere(req),
      orderBy: [{ updated_at: 'desc' }],
    });

    res.json({ callGroups: groups.map(toCallGroup) });
  } catch (err) {
    logger.error('Failed to list call groups:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getCallGroup(req: Request, res: Response) {
  try {
    const group = await prisma.callGroup.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!group) {
      res.status(404).json({ error: 'Call group not found' });
      return;
    }

    res.json({ callGroup: toCallGroup(group) });
  } catch (err) {
    logger.error('Failed to get call group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function createCallGroup(req: Request, res: Response) {
  try {
    const orgId = req.user!.organization_id;

    const group = await prisma.callGroup.create({
      data: {
        name: req.body.name,
        ring: req.body.ring,
        members: req.body.members ?? [],
        organization_id: orgId,
      },
    });

    void logAudit({ req, action: 'callgroup.created', resourceType: 'CallGroup', resourceId: group.id });
    res.status(201).json({ callGroup: toCallGroup(group) });
  } catch (err) {
    logger.error('Failed to create call group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function updateCallGroup(req: Request, res: Response) {
  try {
    const data: any = {};
    if (req.body.name !== undefined) data.name = req.body.name;
    if (req.body.ring !== undefined) data.ring = req.body.ring;
    if (req.body.members !== undefined) data.members = req.body.members;

    // updateMany with id+org filter is atomic (single query) — no TOCTOU window.
    const updateResult = await prisma.callGroup.updateMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
      data,
    });
    if (updateResult.count === 0) {
      res.status(404).json({ error: 'Call group not found' });
      return;
    }
    const group = await prisma.callGroup.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    void logAudit({ req, action: 'callgroup.updated', resourceType: 'CallGroup', resourceId: req.params.id as string });
    res.json({ callGroup: toCallGroup(group) });
  } catch (err) {
    logger.error('Failed to update call group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function deleteCallGroup(req: Request, res: Response) {
  try {
    // deleteMany with id+org filter is atomic — no TOCTOU window.
    const result = await prisma.callGroup.deleteMany({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });
    if (result.count === 0) {
      res.status(404).json({ error: 'Call group not found' });
      return;
    }

    void logAudit({ req, action: 'callgroup.deleted', resourceType: 'CallGroup', resourceId: req.params.id as string });
    res.json({ message: 'Call group deleted' });
  } catch (err) {
    logger.error('Failed to delete call group:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Training-scenario handlers (read-only) ────────────

export async function listTrainingScenarios(req: Request, res: Response) {
  try {
    const scenarios = await prisma.trainingScenario.findMany({
      where: tenantWhere(req),
      orderBy: [{ created_at: 'asc' }],
    });

    res.json({ scenarios: scenarios.map(toTrainingScenario) });
  } catch (err) {
    logger.error('Failed to list training scenarios:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getTrainingScenario(req: Request, res: Response) {
  try {
    // The mock id is a slug; accept either the slug or the UUID.
    const scenario = await prisma.trainingScenario.findFirst({
      where: {
        ...tenantWhere(req),
        OR: [{ slug: req.params.id as string }, { id: req.params.id as string }],
      },
    });

    if (!scenario) {
      res.status(404).json({ error: 'Training scenario not found' });
      return;
    }

    res.json({ scenario: toTrainingScenario(scenario) });
  } catch (err) {
    logger.error('Failed to get training scenario:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ─── Training-session handlers (read-only) ─────────────

export async function listTrainingSessions(req: Request, res: Response) {
  try {
    const sessions = await prisma.trainingSession.findMany({
      where: tenantWhere(req),
      orderBy: [{ completed_at: 'desc' }],
    });

    res.json({ sessions: sessions.map(toTrainingSession) });
  } catch (err) {
    logger.error('Failed to list training sessions:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function getTrainingSession(req: Request, res: Response) {
  try {
    const session = await prisma.trainingSession.findFirst({
      where: { id: req.params.id as string, ...tenantWhere(req) },
    });

    if (!session) {
      res.status(404).json({ error: 'Training session not found' });
      return;
    }

    res.json({ session: toTrainingSession(session) });
  } catch (err) {
    logger.error('Failed to get training session:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
