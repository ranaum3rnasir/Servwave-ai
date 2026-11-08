import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { formatPhoneDisplay } from '../lib/phone-format';
import { BeeService } from '../services/bee/beeService';
import { BeeVoiceAdapter, BEE_MASTER_PROMPT_TEMPLATE } from '../services/bee/beeVoiceAdapter';

// ─── 1. Home / Metrics ────────────────────────────────────────────────────────

export async function getBeeMetrics(req: Request, res: Response) {
  const user = req.user!;
  const range = (req.query.range as string) || '7d';
  try {
    await BeeService.seedDemoDataIfEmpty(user.organization_id);
    const metrics = await BeeService.getMetrics(user.organization_id, range);
    res.json({ ok: true, ...metrics });
  } catch (err: any) {
    logger.error('Failed to get Bee metrics:', err);
    res.status(500).json({ error: 'Failed to retrieve Bee agent metrics' });
  }
}

export const toggleStatusSchema = z.object({
  isActive: z.boolean(),
});

export async function toggleBeeStatus(req: Request, res: Response) {
  const user = req.user!;
  const { isActive } = req.body;

  try {
    const resetSetupConfig = {
      setupDone: [0, 0, 0, 0, 0, 0, 0, 0],
      testPassed: false,
    };

    const updated = await prisma.beeSetting.upsert({
      where: { organization_id: user.organization_id },
      create: {
        organization_id: user.organization_id,
        is_active: isActive,
        ...(isActive === false
          ? {
              call_window_start: '10:00',
              call_window_end: '19:00',
              timezone: 'America/New_York',
              max_retries: 3,
              retry_interval_hours: 48,
              default_lead_owner_id: null,
              alert_email: null,
              alert_phone: null,
              job_type_warranties: [],
              setup_config: resetSetupConfig,
            }
          : {}),
      } as any,
      update:
        isActive === false
          ? ({
              is_active: false,
              call_window_start: '10:00',
              call_window_end: '19:00',
              timezone: 'America/New_York',
              max_retries: 3,
              retry_interval_hours: 48,
              default_lead_owner_id: null,
              alert_email: null,
              alert_phone: null,
              job_type_warranties: [],
              setup_config: resetSetupConfig,
            } as any)
          : ({
              is_active: true,
            } as any),
    });

    res.json({ ok: true, isActive: updated.is_active, settings: updated });
  } catch (err: any) {
    logger.error('Failed to toggle Bee status:', err);
    res.status(500).json({ error: 'Failed to toggle Bee active state' });
  }
}

// ─── 2. Call Logs ─────────────────────────────────────────────────────────────

export async function getBeeCallLogs(req: Request, res: Response) {
  const user = req.user!;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
  const outcome = req.query.outcome as string | undefined;
  const agent = req.query.agent as string | undefined;
  const attempt = req.query.attempt as string | undefined;
  const sentiment = req.query.sentiment as string | undefined;
  const search = req.query.search as string | undefined;

  try {
    // Seed demo data if database has no agents/plans yet
    await BeeService.seedDemoDataIfEmpty(user.organization_id);

    // Reconcile pending/completed Voice Engine calls asynchronously in the background
    // so reading call logs returns instantaneously (<20ms) without blocking on external Vapi HTTP queries
    void BeeService.reconcilePendingCallLogs(user.organization_id).catch((e) => {
      logger.warn('[BeeController] Background reconcilePendingCallLogs error:', e);
    });

    const where: any = { organization_id: user.organization_id };

    const fromDate = (req.query.from || req.query.startDate) as string | undefined;
    const toDate = (req.query.to || req.query.endDate) as string | undefined;
    if (fromDate || toDate) {
      where.called_at = {};
      if (fromDate) where.called_at.gte = new Date(fromDate);
      if (toDate) {
        const toD = toDate.includes('T') ? new Date(toDate) : new Date(`${toDate}T23:59:59.999Z`);
        where.called_at.lte = toD;
      }
    }
    if (outcome && outcome !== 'all') {
      if (outcome === 'answered' || outcome === 'ANSWERED') {
        where.outcome = {
          notIn: [
            'no_answer',
            'voicemail',
            'No answer/Machine',
            'Wrong Number',
            'FAILED',
            'NO_ANSWER',
            'VOICEMAIL',
            'NO_ANSWER,VOICEMAIL',
            'WRONG_NUMBER',
            'NEEDS_REVIEW',
            'CALL_INITIATED',
            'IN_PROGRESS',
          ],
        };
      } else if (outcome === 'no_answer' || outcome === 'NO_ANSWER') {
        where.OR = [
          { outcome: { in: ['NO_ANSWER', 'VOICEMAIL', 'NO_ANSWER,VOICEMAIL', 'no_answer', 'voicemail', 'No answer/Machine'] } },
          { outcome: { contains: 'NO_ANSWER', mode: 'insensitive' } },
          { outcome: { contains: 'VOICEMAIL', mode: 'insensitive' } },
        ];
      } else if (outcome === 'failed' || outcome === 'FAILED') {
        where.outcome = { contains: 'FAILED', mode: 'insensitive' };
      } else if (outcome === 'wrong_number' || outcome === 'WRONG_NUMBER') {
        where.outcome = { contains: 'WRONG', mode: 'insensitive' };
      } else if (outcome === 'needs_review' || outcome === 'NEEDS_REVIEW') {
        where.outcome = { contains: 'NEEDS_REVIEW', mode: 'insensitive' };
      } else if (outcome === 'lead') {
        where.OR = [
          { outcome: { in: ['LEAD_CREATED', 'warranty_lead', 'new_work_lead', 'both_leads'] } },
          { outcome: { contains: 'INTERESTED_', mode: 'insensitive' } },
        ];
      } else if (outcome === 'wlead' || outcome === 'INTERESTED_WARRANTY') {
        where.OR = [
          { outcome: { in: ['LEAD_CREATED', 'warranty_lead', 'INTERESTED_WARRANTY'] } },
          { outcome: { contains: 'INTERESTED_WARRANTY', mode: 'insensitive' } },
          { outcome: { contains: 'both_leads', mode: 'insensitive' } },
          { outcome: { contains: 'INTERESTED_BOTH', mode: 'insensitive' } },
        ];
      } else if (outcome === 'nlead' || outcome === 'INTERESTED_NEW_WORK' || outcome === 'INTERESTED_NEW_JOB') {
        where.OR = [
          { outcome: { in: ['LEAD_CREATED', 'new_work_lead', 'new_job_lead', 'INTERESTED_NEW_WORK', 'INTERESTED_NEW_JOB'] } },
          { outcome: { contains: 'INTERESTED_NEW_WORK', mode: 'insensitive' } },
          { outcome: { contains: 'INTERESTED_NEW_JOB', mode: 'insensitive' } },
          { outcome: { contains: 'both_leads', mode: 'insensitive' } },
          { outcome: { contains: 'INTERESTED_BOTH', mode: 'insensitive' } },
        ];
      } else if (outcome === 'INTERESTED_BOTH') {
        where.OR = [
          { outcome: { in: ['both_leads', 'INTERESTED_BOTH'] } },
          { outcome: { contains: 'INTERESTED_BOTH', mode: 'insensitive' } },
          { outcome: { contains: 'INTERESTED_WARRANTY', mode: 'insensitive' } },
        ];
      } else if (outcome === 'human') {
        where.OR = [
          { outcome: { in: ['HANDOFF_HUMAN', 'COMPLAINT', 'CALLBACK_REQUESTED', 'needs_human'] } },
          { outcome: { contains: 'HANDOFF_HUMAN', mode: 'insensitive' } },
          { outcome: { contains: 'COMPLAINT', mode: 'insensitive' } },
          { outcome: { contains: 'CALLBACK_REQUESTED', mode: 'insensitive' } },
          { needs_human_alert: true },
        ];
      } else if (outcome === 'none') {
        where.OR = [
          {
            outcome: {
              in: [
                'NO_ANSWER',
                'VOICEMAIL',
                'NO_ANSWER,VOICEMAIL',
                'NOT_INTERESTED',
                'DNC_REQUESTED',
                'WRONG_NUMBER',
                'ALREADY_COVERED',
                'no_answer',
                'not_interested',
                'opt_out_dnc',
              ],
            },
          },
          { outcome: { contains: 'NO_ANSWER', mode: 'insensitive' } },
          { outcome: { contains: 'NOT_INTERESTED', mode: 'insensitive' } },
        ];
      } else {
        where.outcome = { contains: outcome, mode: 'insensitive' };
      }
    }

    if (search && search.trim()) {
      const searchClean = search.trim();
      const searchDigits = searchClean.replace(/\D/g, '');
      where.OR = [
        { customer_name: { contains: searchClean, mode: 'insensitive' } },
        { customer_phone: { contains: searchClean } },
        ...(searchDigits.length >= 3 ? [{ customer_phone: { contains: searchDigits } }] : []),
        { ai_summary: { contains: searchClean, mode: 'insensitive' } },
      ];
    }

    const skip = (page - 1) * limit;
    const [rawRecords, total, customers, jobs, warrantyRecords, voiceAgents, relatedTasks] = await Promise.all([
      prisma.beeCallLog.findMany({
        where,
        orderBy: { called_at: 'desc' },
        skip,
        take: limit,
        include: {
          queue_item: {
            include: {
              warranty_record: true,
            },
          },
        },
      }),
      prisma.beeCallLog.count({ where }),
      prisma.customer.findMany({
        where: { organization_id: user.organization_id },
        select: { id: true, first_name: true, last_name: true, company_name: true, phone: true },
        take: 100,
      }),
      prisma.job.findMany({
        where: { organization_id: user.organization_id },
        include: {
          customer: {
            select: { id: true, first_name: true, last_name: true, company_name: true, phone: true },
          },
          estimate: {
            select: { job_type: true },
          },
          lead: {
            select: { job_type: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
      prisma.beeWarrantyRecord.findMany({
        where: { organization_id: user.organization_id },
        orderBy: { warranty_end_date: 'asc' },
        take: 100,
      }),
      prisma.beeVoiceAgent.findMany({
        where: { organization_id: user.organization_id },
        select: { id: true, name: true, persona_name: true },
      }),
      prisma.task.findMany({
        where: {
          organization_id: user.organization_id,
          description: { contains: 'Bee Call Log ID:' },
        },
        select: {
          id: true,
          task_number: true,
          title: true,
          status: true,
          description: true,
        },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    ]);

    const records = rawRecords.map((r, idx) => {
      // Prefer the direct task_id link; fall back to description text-search for legacy records
      const matchedTask = (r as any).task_id
        ? relatedTasks.find((t: any) => t.id === (r as any).task_id) ||
          relatedTasks.find((t: any) => t.description && t.description.includes(r.id))
        : relatedTasks.find((t: any) => t.description && t.description.includes(r.id));
      const lowerName = (r.customer_name || '').toLowerCase().trim();
      const matchedCust =
        customers.find((c) => c.id === r.customer_id) ||
        customers.find((c) => {
          const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().trim();
          const compName = (c.company_name || '').toLowerCase().trim();
          return (fullName && fullName === lowerName) || (compName && compName === lowerName);
        }) ||
        (r.customer_phone ? customers.find((c) => c.phone && c.phone === r.customer_phone) : undefined);

      const resolvedCustId = matchedCust?.id || r.customer_id;

      const matchedWarranty =
        r.queue_item?.warranty_record ||
        warrantyRecords.find((w) => w.customer_id === resolvedCustId);

      let jobId = matchedWarranty?.job_id;
      let matchedJob = jobId ? jobs.find((j) => j.id === jobId) : undefined;
      if (!matchedJob && resolvedCustId) {
        matchedJob = jobs.find((j) => j.customer_id === resolvedCustId);
      }
      if (!matchedJob && lowerName) {
        matchedJob = jobs.find((j) => {
          const c = j.customer;
          if (!c) return false;
          const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().trim();
          const compName = (c.company_name || '').toLowerCase().trim();
          return (fullName && fullName === lowerName) || (compName && compName === lowerName);
        });
      }
      if (!matchedJob && jobs.length > 0) {
        matchedJob = jobs[idx % jobs.length];
      }
      if (matchedJob) {
        jobId = matchedJob.id;
      }

      const customerId = matchedJob?.customer_id || resolvedCustId;

      const rawJobNumber = matchedJob?.job_number ? String(matchedJob.job_number).trim() : '';
      const jobNum = rawJobNumber
        ? rawJobNumber.startsWith('#')
          ? rawJobNumber
          : `#${rawJobNumber}`
        : jobId
        ? `#${jobId.slice(0, 8)}`
        : '—';

      const jobDesc =
        matchedJob?.job_type ||
        matchedJob?.estimate?.job_type ||
        matchedJob?.lead?.job_type ||
        matchedWarranty?.job_type ||
        'General Service';

      const formattedJob = jobNum !== '—' ? `${jobNum} · ${jobDesc}` : jobDesc;

      // Map outcome to multi-tag outcomes + backward-compatible primary code
      const parsedOutcome = BeeService.parseOutcomeTags(r.outcome, null, r.needs_human_alert);
      const outCode = parsedOutcome.primaryLegacyCode;
      const outcomeTags = parsedOutcome.tags;
      const lf = parsedOutcome.leadFormat;
      const val = r.cost_estimate ? `$${r.cost_estimate}` : '—';
      const bk = r.lead_id
        ? `Lead #${r.lead_id.slice(-6)}`
        : parsedOutcome.needsHumanAlert
        ? 'Alert → Office'
        : '—';
      const sent = parsedOutcome.sentiment;

      const agentObj = voiceAgents.find((a) => a.id === r.agent_id);
      const agentName = agentObj?.name || 'Bee Outbound Agent';
      const attemptStr = r.queue_item?.attempt_count ? `${r.queue_item.attempt_count} of 3` : '1 of 3';
      const dateFormatted = new Date(r.called_at).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

      const durM = Math.floor(r.duration_seconds / 60);
      const durS = (r.duration_seconds % 60).toString().padStart(2, '0');
      const durFormatted = `${durM}:${durS}`;

      const warrantyEnds = matchedWarranty?.warranty_end_date
        ? new Date(matchedWarranty.warranty_end_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : '—';

      const got = r.lead_id ? [`Lead #${r.lead_id.slice(-6)}`] : [];
      const miss: string[] = [];
      const obj: string[] = [];

      return {
        id: r.id,
        customer_id: customerId,
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        job_id: jobId,
        job_number: jobNum,
        job_type: jobDesc,
        job_title: formattedJob,
        warranty_ends: warrantyEnds,
        agent_id: r.agent_id,
        agent_name: agentName,
        agent_version: 'v3',
        attempt: attemptStr,
        duration_seconds: r.duration_seconds,
        duration_formatted: durFormatted,
        outcome: outCode,
        outcomes: outcomeTags,
        is_answered: parsedOutcome.isAnswered,
        outcome_label: outCode,
        lead_format: lf,
        lead_id: r.lead_id,
        lead_label: bk,
        value: val,
        sentiment: sent,
        needs_human_alert: r.needs_human_alert || parsedOutcome.needsHumanAlert,
        ai_summary: r.ai_summary,
        transcript: r.transcript,
        audio_url: r.audio_url || undefined,
        called_at: r.called_at,
        t: dateFormatted,
        c: r.customer_name,
        p: formatPhoneDisplay(r.customer_phone),
        j: jobNum,
        jt: jobDesc,
        we: warrantyEnds,
        ag: agentName,
        at: attemptStr,
        d: durFormatted,
        o: outCode,
        lf: lf,
        bk: bk,
        v: val,
        sent: sent,
        ver: 'v3',
        sum: r.ai_summary || 'Call attempt recorded.',
        got,
        miss,
        obj,
        task: matchedTask
          ? {
              id: matchedTask.id,
              task_number: matchedTask.task_number,
              title: matchedTask.title,
              status: matchedTask.status,
            }
          : null,
        task_id: matchedTask?.id || null,
        task_number: matchedTask?.task_number || null,
        task_title: matchedTask?.title || null,
        task_status: matchedTask?.status || null,
      };
    });

    res.json({
      ok: true,
      records,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    logger.error('Failed to get Bee call logs:', err);
    res.status(500).json({ error: 'Failed to retrieve call logs' });
  }
}

export async function getBeeCallDetail(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;

  try {
    let call = await prisma.beeCallLog.findFirst({
      where: { id, organization_id: user.organization_id },
      include: {
        queue_item: {
          include: {
            warranty_record: true,
          },
        },
      },
    });

    if (!call) {
      return res.status(404).json({ error: 'Call log not found' });
    }

    // If the call is still in CALL_INITIATED state, ingest its finished result from the Voice Engine.
    // If already completed but the recording URL is missing/expired, refresh only the audio_url if changed.
    if (call.outcome === 'CALL_INITIATED' || call.outcome === 'IN_PROGRESS') {
      const details = await BeeVoiceAdapter.getCallDetails(user.organization_id, call.id);
      if (details && (details.status === 'ended' || details.status === 'failed')) {
        await BeeService.ingestCallResultStageOne(user.organization_id, details);
        call = await prisma.beeCallLog.findFirst({
          where: { id, organization_id: user.organization_id },
          include: {
            queue_item: {
              include: {
                warranty_record: true,
              },
            },
          },
        });
      }
    } else if (BeeService.isAudioUrlUnsignedOrExpired(call.audio_url)) {
      const details = await BeeVoiceAdapter.getCallDetails(user.organization_id, call.id);
      const freshAudioUrl = details?.recordingUrl || details?.stereoRecordingUrl || null;
      if (freshAudioUrl && freshAudioUrl !== call.audio_url) {
        call = await prisma.beeCallLog.update({
          where: { id: call.id },
          data: { audio_url: freshAudioUrl },
          include: {
            queue_item: {
              include: {
                warranty_record: true,
              },
            },
          },
        });
      }
    }

    if (!call) {
      return res.status(404).json({ error: 'Call log not found' });
    }

    const targetCallId: string = call.id;
    // Prefer the direct task_id link (set when Bee auto-creates the task);
    // fall back to description text-search for older records that predate the column.
    const directTaskId = (call as any).task_id as string | null | undefined;
    const linkedTask = await (directTaskId
      ? prisma.task.findFirst({
          where: {
            id: directTaskId,
            organization_id: user.organization_id,
          },
          select: {
            id: true,
            task_number: true,
            title: true,
            status: true,
            priority: true,
          },
        })
      : null) ?? await prisma.task.findFirst({
      where: {
        organization_id: user.organization_id,
        description: { contains: targetCallId },
      },
      select: {
        id: true,
        task_number: true,
        title: true,
        status: true,
        priority: true,
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({
      ok: true,
      call: {
        ...call,
        customer_phone: formatPhoneDisplay(call.customer_phone),
        p: formatPhoneDisplay(call.customer_phone),
        task: linkedTask
          ? {
              id: linkedTask.id,
              task_number: linkedTask.task_number,
              title: linkedTask.title,
              status: linkedTask.status,
            }
          : null,
        task_id: linkedTask?.id || null,
        task_number: linkedTask?.task_number || null,
        task_title: linkedTask?.title || null,
        task_status: linkedTask?.status || null,
      },
    });
  } catch (err: any) {
    logger.error('Failed to get Bee call detail:', err);
    res.status(500).json({ error: 'Failed to retrieve call detail' });
  }
}

export async function updateBeeCallOutcome(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;
  const { outcome } = req.body;

  if (!outcome) {
    return res.status(400).json({ error: 'Outcome is required' });
  }

  try {
    const parsed = BeeService.parseOutcomeTags(outcome);
    const storedOutcome = parsed.tags.join(',');

    const updated = await prisma.beeCallLog.updateMany({
      where: { id, organization_id: user.organization_id },
      data: {
        outcome: storedOutcome,
        needs_human_alert: parsed.needsHumanAlert,
      },
    });

    res.json({
      ok: true,
      count: updated.count,
      outcome: storedOutcome,
      outcomes: parsed.tags,
      is_answered: parsed.isAnswered,
    });
  } catch (err: any) {
    logger.error('Failed to update Bee call outcome:', err);
    res.status(500).json({ error: 'Failed to update outcome' });
  }
}

/**
 * PATCH /api/bee/calls/:id/task
 * Links a follow-up task to a call log record (e.g. after a user manually creates one).
 * Body: { task_id: string }
 */
export async function linkBeeCallTask(req: Request, res: Response) {
  const user = req.user!;
  const callId = req.params.id as string;
  const { task_id } = req.body;

  if (!task_id || typeof task_id !== 'string') {
    return res.status(400).json({ error: 'task_id is required' });
  }

  try {
    // Verify the task belongs to this org
    const task = await prisma.task.findFirst({
      where: { id: task_id, organization_id: user.organization_id },
      select: { id: true, task_number: true, title: true, status: true },
    });
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Update the call log
    const updated = await prisma.beeCallLog.updateMany({
      where: { id: callId, organization_id: user.organization_id },
      data: { task_id: task.id },
    });

    if (updated.count === 0) {
      return res.status(404).json({ error: 'Call log not found' });
    }

    res.json({
      ok: true,
      task: {
        id: task.id,
        task_number: task.task_number,
        title: task.title,
        status: task.status,
      },
    });
  } catch (err: any) {
    logger.error('Failed to link task to Bee call log:', err);
    res.status(500).json({ error: 'Failed to link task' });
  }
}

// ─── 3. Queue ─────────────────────────────────────────────────────────────────

export async function getBeeQueue(req: Request, res: Response) {
  const user = req.user!;
  const status = (req.query.status as string) || 'scheduled';

  try {
    const statusWhere =
      status === 'all'
        ? {}
        : status === 'scheduled' || status === 'skipped'
          ? { status: { in: ['scheduled', 'skipped', 'in_progress'] } }
          : { status };

    const rawItems = await prisma.beeQueueItem.findMany({
      where: {
        organization_id: user.organization_id,
        ...statusWhere,
      },
      include: {
        warranty_record: true,
      },
      orderBy: { scheduled_for: 'asc' },
    });

    const enriched = await BeeService.enrichQueueItemsWithJobContext(user.organization_id, rawItems);
    const items =
      status === 'all'
        ? enriched
        : status === 'scheduled'
          ? enriched.filter((item: any) => item.status === 'scheduled' || item.status === 'in_progress')
          : enriched.filter((item: any) => item.status === status);

    res.json({ ok: true, items });
  } catch (err: any) {
    logger.error('Failed to get Bee queue items:', err);
    res.status(500).json({ error: 'Failed to retrieve queue items' });
  }
}

export async function triggerCallNow(req: Request, res: Response) {
  const user = req.user!;
  const { queueItemId } = req.body;

  try {
    const rawQueueItem = await prisma.beeQueueItem.findFirst({
      where: { id: queueItemId, organization_id: user.organization_id },
      include: {
        warranty_record: true,
      },
    });

    if (!rawQueueItem) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    // Run independent lookups in parallel: job context enrichment, DNC check, warranty plans
    const [enrichedItems, isDnc, activePlans] = await Promise.all([
      BeeService.enrichQueueItemsWithJobContext(user.organization_id, [rawQueueItem]),
      BeeService.isDnc(user.organization_id, rawQueueItem.customer_phone),
      prisma.beeWarrantyPlan.findMany({
        where: { organization_id: user.organization_id, is_active: true },
        orderBy: { price: 'asc' },
      }),
    ]);
    const [queueItem] = enrichedItems;

    // Check DNC (re-check only if enrichment resolved a different customer phone)
    const phoneChanged = queueItem.customer_phone !== rawQueueItem.customer_phone;
    if (
      isDnc ||
      (phoneChanged && (await BeeService.isDnc(user.organization_id, queueItem.customer_phone)))
    ) {
      await prisma.beeQueueItem.update({
        where: { id: queueItemId },
        data: { status: 'skipped', skip_reason: 'Do Not Call list match' },
      });
      return res.status(400).json({ error: 'Cannot call: number is registered on Do Not Call list' });
    }

    // Resolve voice agent and outbound phone number assigned to that agent according to job type
    const itemJobType = queueItem.job_type || queueItem.warranty_record?.job_type || 'General Service';
    const { agent, fromPhoneNumber, fromPhoneNumberId } =
      await BeeService.resolveAgentAndPhoneNumberForJob(user.organization_id, itemJobType, {
        preferredAgentId: queueItem.agent_id || rawQueueItem.agent_id,
        preferredPhone: queueItem.from_phone_number,
      });

    const callResult = await BeeVoiceAdapter.initiateCall(user.organization_id, {
      to: queueItem.customer_phone,
      from: fromPhoneNumber,
      phoneNumberId: fromPhoneNumberId,
      agentId: agent?.id,
      agentName: agent?.name,
      voiceId: agent?.voice_id,
      externalAgentId: agent?.vapi_assistant_id || undefined,
      customerId: queueItem.customer_id,
      customerName: queueItem.customer_name,
      agentPersona: agent?.persona_name || 'Emma',
      agentTone: agent?.tone,
      agentLanguage: agent?.language,
      tradeFocus: agent?.trade_focus || itemJobType,
      jobId: queueItem.job_id,
      jobNumber: queueItem.job_number,
      jobType: itemJobType,
      queueItemId,
      isTestCall: false,
      serviceRequest: queueItem.service_request,
      scopeNotes: queueItem.scope_notes,
      completionNotes: queueItem.completion_notes,
      serviceAddress: queueItem.service_address,
      completedAt: queueItem.completed_at ? new Date(queueItem.completed_at).toISOString() : undefined,
      warrantyStartDate: queueItem.warranty_record?.warranty_start_date
        ? new Date(queueItem.warranty_record.warranty_start_date).toISOString()
        : undefined,
      warrantyEndDate: queueItem.warranty_record?.warranty_end_date
        ? new Date(queueItem.warranty_record.warranty_end_date).toISOString()
        : undefined,
      warrantyStatus: queueItem.warranty_record?.status,
      lineItemsSummary: queueItem.job_info?.line_items_summary,
      warrantyOfferPitch: agent?.warranty_offer_pitch || undefined,
      newWorkPitch: agent?.new_work_pitch || undefined,
      conversationFlow: agent?.conversation_flow,
      selectedJobContextFields: agent?.job_context_fields,
      jobContextVariables: queueItem.job_context_variables,
      availablePlans: activePlans.map((p) => ({
        name: p.name,
        price: Number(p.price),
        durationMonths: p.duration_months,
        description: p.description || undefined,
      })),
    });

    if (agent?.id && !agent?.vapi_assistant_id && callResult.assistantId) {
      const packedWithAssistant = BeeService.packAgentMetadata(
        { vapi_assistant_id: callResult.assistantId, voice_engine: callResult.engineType || 'vapi' },
        agent
      );
      await prisma.beeVoiceAgent
        .update({
          where: { id: agent.id },
          data: { eligible_job_types: packedWithAssistant.packedJson as any },
        })
        .catch(() => {});
    }

    if (callResult.status === 'failed') {
      await prisma.beeQueueItem.update({
        where: { id: queueItemId },
        data: {
          customer_id: queueItem.customer_id,
          customer_name: queueItem.customer_name,
          customer_phone: queueItem.customer_phone,
          status: 'failed',
          last_attempted_at: new Date(),
          attempt_count: { increment: 1 },
          skip_reason: callResult.error,
        },
      });

      const failedLog = await BeeService.createInitialCallLog(user.organization_id, {
        callId: callResult.callId,
        status: 'failed',
        provider: callResult.provider,
        customerId: queueItem.customer_id,
        customerName: queueItem.customer_name,
        customerPhone: queueItem.customer_phone,
        agentId: agent?.id || queueItem.agent_id,
        queueItemId,
        jobNumber: queueItem.job_number,
        jobType: queueItem.job_type,
        error: callResult.error,
      });

      return res.status(400).json({ ok: false, error: callResult.error, callResult, callLogId: failedLog.id });
    }

    await prisma.beeQueueItem.update({
      where: { id: queueItemId },
      data: {
        customer_id: queueItem.customer_id,
        customer_name: queueItem.customer_name,
        customer_phone: queueItem.customer_phone,
        status: 'in_progress',
        last_attempted_at: new Date(),
        attempt_count: { increment: 1 },
      },
    });

    const initialLog = await BeeService.createInitialCallLog(user.organization_id, {
      callId: callResult.callId,
      status: 'initiated',
      provider: callResult.provider,
      customerId: queueItem.customer_id,
      customerName: queueItem.customer_name,
      customerPhone: queueItem.customer_phone,
      agentId: agent?.id || queueItem.agent_id,
      queueItemId,
      jobNumber: queueItem.job_number,
      jobType: queueItem.job_type,
    });

    res.json({ ok: true, callResult, callLogId: initialLog.id, jobInfo: queueItem.job_info });
  } catch (err: any) {
    logger.error('Failed to trigger call now:', err);
    res.status(500).json({ error: 'Failed to trigger call' });
  }
}

export async function skipQueueItem(req: Request, res: Response) {
  const user = req.user!;
  const { queueItemId, reason } = req.body;

  try {
    const updated = await prisma.beeQueueItem.updateMany({
      where: { id: queueItemId, organization_id: user.organization_id },
      data: {
        status: 'skipped',
        skip_reason: reason || 'Manually skipped by admin',
      },
    });

    res.json({ ok: true, count: updated.count });
  } catch (err: any) {
    logger.error('Failed to skip queue item:', err);
    res.status(500).json({ error: 'Failed to update queue item' });
  }
}

export async function rescheduleBeeQueueItem(req: Request, res: Response) {
  const user = req.user!;
  const queueItemId = (req.params.id || req.body.queueItemId || req.body.id) as string;
  const { scheduledFor } = req.body;

  if (!queueItemId) {
    return res.status(400).json({ error: 'queueItemId is required' });
  }

  if (!scheduledFor) {
    return res.status(400).json({ error: 'scheduledFor is required' });
  }

  try {
    const updated = await BeeService.rescheduleQueueItem(
      user.organization_id,
      queueItemId,
      scheduledFor
    );
    res.json({ ok: true, item: updated });
  } catch (err: any) {
    logger.error('Failed to reschedule Bee queue item:', err);
    res.status(400).json({ error: err.message || 'Failed to reschedule queue item' });
  }
}

// ─── 4. Agents ────────────────────────────────────────────────────────────────

export async function getBeeAgents(req: Request, res: Response) {
  const user = req.user!;
  try {
    await BeeService.seedDemoDataIfEmpty(user.organization_id);

    const [rawAgents, availableNumbers, sampleJobsRes, org] = await Promise.all([
      prisma.beeVoiceAgent.findMany({
        where: { organization_id: user.organization_id },
        orderBy: { created_at: 'asc' },
      }),
      BeeService.getAvailablePhoneNumbers(user.organization_id),
      BeeService.getSampleJobsForAgentContext(user.organization_id, 10),
      prisma.organization.findUnique({
        where: { id: user.organization_id },
        select: { name: true },
      }),
    ]);

    const agents = rawAgents.map((a) => BeeService.normalizeAgentRecord(a));

    res.json({
      ok: true,
      agents,
      availableNumbers,
      sampleJobs: sampleJobsRes.jobs,
      companyName: org?.name || 'Our Service Team',
      masterPromptTemplate: BEE_MASTER_PROMPT_TEMPLATE,
    });
  } catch (err: any) {
    logger.error('Failed to get Bee agents:', err);
    res.status(500).json({ error: 'Failed to retrieve agent personas' });
  }
}

export const createBeeAgentSchema = z.object({
  name: z.string().min(1),
  persona_name: z.string().default('Emma'),
  voice_id: z.string().default('friendly_female_1'),
  trade_focus: z.string().default('General'),
  trigger_days_before: z.number().int().default(30),
  eligible_job_types: z.array(z.string()).optional().default([]),
  job_context_fields: z.array(z.string()).optional(),
  conversation_flow: z
    .object({
      greeting_pitch: z.string().optional(),
      checkin_flow: z.string().optional(),
      warranty_offer_pitch: z.string().optional(),
      new_work_pitch: z.string().optional(),
      objection_handling: z.string().optional(),
      custom_instructions: z.string().optional(),
    })
    .optional(),
  default_from_number: z.string().optional(),
  default_from_number_id: z.string().optional(),
  vapi_assistant_id: z.string().optional(),
  voice_engine: z.string().optional(),
  language: z.string().optional(),
  tone: z.string().optional(),
  warranty_offer_pitch: z.string().optional(),
  new_work_pitch: z.string().optional(),
  is_active: z.boolean().default(true),
});

export async function createBeeAgent(req: Request, res: Response) {
  const user = req.user!;
  const body = req.body;

  try {
    const packed = BeeService.packAgentMetadata(body);

    let created = await prisma.beeVoiceAgent.create({
      data: {
        organization_id: user.organization_id,
        name: body.name,
        persona_name: body.persona_name || 'Emma',
        voice_id: body.voice_id || 'friendly_female_1',
        trade_focus: body.trade_focus || 'General',
        trigger_days_before: body.trigger_days_before || 30,
        eligible_job_types: packed.packedJson as any,
        warranty_offer_pitch: packed.warranty_offer_pitch,
        new_work_pitch: packed.new_work_pitch,
        is_active: body.is_active ?? true,
      },
    });

    const normalizedCreated = BeeService.normalizeAgentRecord(created);

    // Sync agent creation to the active Voice Calling Engine (e.g. Vapi POST /assistant)
    const engineSync = await BeeVoiceAdapter.syncAgentCreate(
      user.organization_id,
      normalizedCreated
    );

    if (engineSync.externalAgentId) {
      const packedWithEngineId = BeeService.packAgentMetadata(
        {
          ...body,
          vapi_assistant_id: engineSync.externalAgentId,
          voice_engine: engineSync.engineType,
        },
        created
      );
      created = await prisma.beeVoiceAgent.update({
        where: { id: created.id, organization_id: user.organization_id },
        data: {
          eligible_job_types: packedWithEngineId.packedJson as any,
        },
      });
    }

    res.json({
      ok: true,
      agent: BeeService.normalizeAgentRecord(created),
      engineSync,
    });
  } catch (err: any) {
    logger.error('Failed to create Bee agent:', err);
    res.status(500).json({ error: 'Failed to create agent persona' });
  }
}

export async function updateBeeAgent(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;
  const body = req.body;

  try {
    const existing = await prisma.beeVoiceAgent.findFirst({
      where: { id, organization_id: user.organization_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent persona not found' });
    }

    const packed = BeeService.packAgentMetadata(body, existing);

    let updated = await prisma.beeVoiceAgent.update({
      where: { id, organization_id: user.organization_id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.persona_name !== undefined ? { persona_name: body.persona_name } : {}),
        ...(body.voice_id !== undefined ? { voice_id: body.voice_id } : {}),
        ...(body.trade_focus !== undefined ? { trade_focus: body.trade_focus } : {}),
        ...(body.trigger_days_before !== undefined ? { trigger_days_before: body.trigger_days_before } : {}),
        eligible_job_types: packed.packedJson as any,
        warranty_offer_pitch: packed.warranty_offer_pitch,
        new_work_pitch: packed.new_work_pitch,
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
      },
    });

    const normalizedUpdated = BeeService.normalizeAgentRecord(updated);

    // Sync agent update (name, persona, voice, conversation flow, and master prompt) to Vapi (PATCH /assistant/:id)
    const engineSync = await BeeVoiceAdapter.syncAgentUpdate(
      user.organization_id,
      normalizedUpdated,
      normalizedUpdated?.vapi_assistant_id
    );

    if (
      engineSync.externalAgentId &&
      engineSync.externalAgentId !== normalizedUpdated?.vapi_assistant_id
    ) {
      const packedWithEngineId = BeeService.packAgentMetadata(
        {
          vapi_assistant_id: engineSync.externalAgentId,
          voice_engine: engineSync.engineType,
        },
        updated
      );
      updated = await prisma.beeVoiceAgent.update({
        where: { id: updated.id, organization_id: user.organization_id },
        data: {
          eligible_job_types: packedWithEngineId.packedJson as any,
        },
      });
    }

    res.json({
      ok: true,
      agent: BeeService.normalizeAgentRecord(updated),
      engineSync,
    });
  } catch (err: any) {
    logger.error('Failed to update Bee agent:', err);
    res.status(500).json({ error: 'Failed to update agent persona' });
  }
}

export async function deleteBeeAgent(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;

  try {
    const existing = await prisma.beeVoiceAgent.findFirst({
      where: { id, organization_id: user.organization_id },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const normalizedExisting = BeeService.normalizeAgentRecord(existing);

    // Delete assistant from active Voice Calling Engine (e.g. Vapi DELETE /assistant/:id)
    const engineDelete = await BeeVoiceAdapter.syncAgentDelete(
      user.organization_id,
      normalizedExisting?.vapi_assistant_id,
      normalizedExisting?.voice_engine
    );

    // Clear agent reference from scheduled queue items
    await prisma.beeQueueItem.updateMany({
      where: { organization_id: user.organization_id, agent_id: id },
      data: { agent_id: null },
    });

    await prisma.beeVoiceAgent.delete({
      where: { id, organization_id: user.organization_id },
    });

    res.json({ ok: true, deletedId: id, engineDelete });
  } catch (err: any) {
    logger.error('Failed to delete Bee agent:', err);
    res.status(500).json({ error: 'Failed to delete agent persona' });
  }
}

export async function triggerTestCall(req: Request, res: Response) {
  const user = req.user!;
  const {
    phoneNumber,
    toNumber,
    fromNumber,
    phoneNumberId,
    agentId,
    jobId,
    conversationFlow,
    selectedJobContextFields,
  } = req.body;

  const targetTo = (toNumber || phoneNumber || '').trim();
  if (!targetTo) {
    return res.status(400).json({ error: 'Destination phone number (to_number) is required for test call' });
  }

  try {
    let rawAgent = null;
    if (agentId) {
      rawAgent = await prisma.beeVoiceAgent.findFirst({
        where: { id: agentId, organization_id: user.organization_id },
      });
    }
    if (!rawAgent) {
      rawAgent = await prisma.beeVoiceAgent.findFirst({
        where: { organization_id: user.organization_id, is_active: true },
      });
    }
    const agent = BeeService.normalizeAgentRecord(rawAgent);

    const [sampleJobsRes, activePlans, availableNumbers] = await Promise.all([
      BeeService.getSampleJobsForAgentContext(user.organization_id, 10, 0, undefined, jobId),
      prisma.beeWarrantyPlan.findMany({
        where: { organization_id: user.organization_id, is_active: true },
        orderBy: { price: 'asc' },
      }),
      BeeService.getAvailablePhoneNumbers(user.organization_id),
    ]);

    const sampleJobs = sampleJobsRes.jobs;
    const selectedJob =
      (jobId ? sampleJobs.find((j) => j.id === jobId) : undefined) || sampleJobs[0];

    const resolvedFrom = (fromNumber || agent?.default_from_number || '').trim() || undefined;
    const matchedPhoneObj = availableNumbers.find(
      (n) =>
        (phoneNumberId && (n.id === phoneNumberId || n.vapiPhoneNumberId === phoneNumberId)) ||
        (resolvedFrom && (n.e164 === resolvedFrom || n.phoneNumber === resolvedFrom || n.id === resolvedFrom))
    );
    const resolvedPhoneNumberId =
      phoneNumberId ||
      matchedPhoneObj?.vapiPhoneNumberId ||
      agent?.default_from_number_id ||
      availableNumbers.find((n) => n.vapiPhoneNumberId)?.vapiPhoneNumberId ||
      undefined;

    const resolvedFlow = conversationFlow || agent?.conversation_flow;
    const resolvedFields =
      Array.isArray(selectedJobContextFields) && selectedJobContextFields.length > 0
        ? selectedJobContextFields
        : agent?.job_context_fields;

    if (!availableNumbers || availableNumbers.length === 0 || !resolvedPhoneNumberId) {
      return res.status(400).json({
        ok: false,
        error:
          'Bee Phone System is not configured. Please go to Setup -> Phone system and configure or buy at least one phone number before launching test calls.',
      });
    }

    const callResult = await BeeVoiceAdapter.initiateCall(user.organization_id, {
      to: targetTo,
      from: matchedPhoneObj?.e164 || resolvedFrom,
      phoneNumberId: resolvedPhoneNumberId,
      agentId: agent?.id,
      agentName: agent?.name,
      voiceId: agent?.voice_id,
      externalAgentId: agent?.vapi_assistant_id || undefined,
      customerId: selectedJob?.customer_id,
      customerName: selectedJob?.customer_name || `${user.first_name} ${user.last_name}`,
      agentPersona: agent?.persona_name || 'Emma',
      agentTone: agent?.tone,
      agentLanguage: agent?.language,
      tradeFocus: agent?.trade_focus || selectedJob?.job_type || 'Doors & Locks',
      jobId: selectedJob?.id,
      jobNumber: selectedJob?.job_number,
      jobType: selectedJob?.job_type || agent?.trade_focus || 'General Service',
      isTestCall: true,
      serviceRequest: selectedJob?.service_request,
      scopeNotes: selectedJob?.scope_notes,
      completionNotes: selectedJob?.completion_notes,
      serviceAddress: selectedJob?.service_address,
      completedAt: selectedJob?.completed_at
        ? new Date(selectedJob.completed_at).toISOString()
        : undefined,
      warrantyEndDate: selectedJob?.warranty_end_date,
      warrantyStatus: selectedJob?.warranty_status,
      warrantyOfferPitch: agent?.warranty_offer_pitch || undefined,
      newWorkPitch: agent?.new_work_pitch || undefined,
      conversationFlow: resolvedFlow,
      selectedJobContextFields: resolvedFields,
      jobContextVariables: selectedJob?.job_context_variables,
      availablePlans: activePlans.map((p) => ({
        name: p.name,
        price: Number(p.price),
        durationMonths: p.duration_months,
        description: p.description || undefined,
      })),
    });

    if (agent?.id && !agent?.vapi_assistant_id && callResult.assistantId) {
      const packedWithAssistant = BeeService.packAgentMetadata(
        { vapi_assistant_id: callResult.assistantId, voice_engine: callResult.engineType || 'vapi' },
        agent
      );
      await prisma.beeVoiceAgent
        .update({
          where: { id: agent.id },
          data: { eligible_job_types: packedWithAssistant.packedJson as any },
        })
        .catch(() => {});
    }

    const resolvedCustomerName =
      selectedJob?.customer_name || `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Test Caller';

    if (callResult.status === 'failed') {
      if (callResult.callId) {
        await BeeService.createInitialCallLog(user.organization_id, {
          callId: callResult.callId,
          status: 'failed',
          provider: callResult.provider,
          customerId: selectedJob?.customer_id,
          customerName: resolvedCustomerName,
          customerPhone: callResult.toNumber || targetTo,
          agentId: agent?.id,
          jobNumber: selectedJob?.job_number,
          jobType: selectedJob?.job_type,
          error: callResult.error,
          isTestCall: true,
        });
      }

      return res.status(400).json({
        ok: false,
        error: callResult.error,
        callResult,
        mergedPrompt: callResult.mergedPrompt,
        dynamicVariables: callResult.dynamicVariables,
      });
    }

    // Create the initial BeeCallLog record (`CALL_INITIATED` with empty transcript/recording)
    // and register server-side post-call result delivery so the same row updates once Vapi finishes
    const initialLog = await BeeService.createInitialCallLog(user.organization_id, {
      callId: callResult.callId,
      status: 'initiated',
      provider: callResult.provider,
      customerId: selectedJob?.customer_id,
      customerName: resolvedCustomerName,
      customerPhone: callResult.toNumber || targetTo,
      agentId: agent?.id,
      jobNumber: selectedJob?.job_number,
      jobType: selectedJob?.job_type,
      isTestCall: true,
    });

    res.json({
      ok: true,
      message: `Test call initiated via ${callResult.provider.toUpperCase()} from ${callResult.fromNumber || 'default line'} to ${targetTo}. Call log created (${initialLog.id}).`,
      callLogId: initialLog.id,
      callResult,
      mergedPrompt: callResult.mergedPrompt,
      dynamicVariables: callResult.dynamicVariables,
    });
  } catch (err: any) {
    logger.error('Failed to trigger test call:', err);
    res.status(500).json({ error: 'Failed to initiate test call' });
  }
}

export async function getBeeSampleJobs(req: Request, res: Response) {
  const user = req.user!;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
  const offset = Math.max(0, parseInt(req.query.offset as string) || 0);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : undefined;

  try {
    const result = await BeeService.getSampleJobsForAgentContext(
      user.organization_id,
      limit,
      offset,
      search,
      jobId
    );

    res.json({
      ok: true,
      jobs: result.jobs,
      total: result.total,
      hasMore: result.hasMore,
      offset: result.offset,
      limit: result.limit,
    });
  } catch (err: any) {
    logger.error('[BeeController] Failed to search sample jobs:', err);
    res.status(500).json({ error: 'Failed to retrieve sample jobs' });
  }
}

// ─── 5. Warranty Plans ────────────────────────────────────────────────────────

export async function getBeePlans(req: Request, res: Response) {
  const user = req.user!;
  try {
    const plans = await prisma.beeWarrantyPlan.findMany({
      where: { organization_id: user.organization_id },
      orderBy: { created_at: 'asc' },
    });

    const enrichedPlans = plans.map((p) => {
      const inc = (p.inclusions && typeof p.inclusions === 'object' && !Array.isArray(p.inclusions))
        ? (p.inclusions as Record<string, any>)
        : {};
      return {
        ...p,
        per: inc.per || 'job',
        len: inc.len || `${p.duration_months} months`,
        covered: inc.covered || p.description || '',
        files: Array.isArray(inc.files) ? inc.files : [],
        for: inc.for || (Array.isArray(p.eligible_job_types) && p.eligible_job_types.length > 0 ? p.eligible_job_types[0] : 'All job types'),
      };
    });

    res.json({ ok: true, plans: enrichedPlans });
  } catch (err: any) {
    logger.error('Failed to get Bee plans:', err);
    res.status(500).json({ error: 'Failed to retrieve warranty plans' });
  }
}

export const createBeePlanSchema = z.object({
  name: z.string().min(1),
  duration_months: z.number().int().min(1).optional().default(12),
  price: z.number().min(0),
  billing_interval: z.string().default('one_time'),
  description: z.string().optional(),
  inclusions: z.any().optional().default([]),
  eligible_job_types: z.array(z.string()).default([]),
  is_active: z.boolean().default(true),
});

export async function createBeePlan(req: Request, res: Response) {
  const user = req.user!;
  const body = req.body;

  try {
    // Determine duration_months if passed as len string
    let durationMonths = body.duration_months || 12;
    if (body.len) {
      durationMonths = Math.max(1, Math.round(BeeService.parseWarrantyDurationToDays(body.len) / 30));
    }

    // Build inclusions payload
    let inclusionsPayload: any = body.inclusions;
    if (body.per || body.len || body.covered || body.files || body.for) {
      inclusionsPayload = {
        per: body.per || 'job',
        len: body.len || `${durationMonths} months`,
        covered: body.covered || body.description || '',
        files: Array.isArray(body.files) ? body.files : [],
        for: body.for || 'All job types',
        items: Array.isArray(body.inclusions) ? body.inclusions : [body.covered || body.description || ''],
      };
    }

    const plan = await prisma.beeWarrantyPlan.create({
      data: {
        organization_id: user.organization_id,
        name: body.name,
        duration_months: durationMonths,
        price: body.price,
        billing_interval: body.billing_interval || (body.billing?.toLowerCase() === 'yearly' ? 'yearly' : body.billing?.toLowerCase() === 'monthly' ? 'monthly' : 'one_time'),
        description: body.covered || body.description,
        inclusions: inclusionsPayload || [],
        eligible_job_types: body.eligible_job_types || (body.for ? [body.for] : ['All job types']),
        is_active: body.is_active ?? true,
      },
    });

    res.json({ ok: true, plan });
  } catch (err: any) {
    logger.error('Failed to create Bee plan:', err);
    res.status(500).json({ error: 'Failed to create warranty plan' });
  }
}

export async function updateBeePlan(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;
  const body = req.body;

  try {
    let durationMonths = body.duration_months;
    if (body.len && !durationMonths) {
      durationMonths = Math.max(1, Math.round(BeeService.parseWarrantyDurationToDays(body.len) / 30));
    }

    let inclusionsPayload: any = body.inclusions;
    if (body.per || body.len || body.covered || body.files || body.for) {
      inclusionsPayload = {
        per: body.per || 'job',
        len: body.len || (durationMonths ? `${durationMonths} months` : '12 months'),
        covered: body.covered || body.description || '',
        files: Array.isArray(body.files) ? body.files : [],
        for: body.for || 'All job types',
        items: Array.isArray(body.inclusions) ? body.inclusions : [body.covered || body.description || ''],
      };
    }

    const plan = await prisma.beeWarrantyPlan.update({
      where: { id, organization_id: user.organization_id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(durationMonths !== undefined ? { duration_months: durationMonths } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.billing_interval !== undefined ? { billing_interval: body.billing_interval } : body.billing ? { billing_interval: body.billing.toLowerCase() === 'yearly' ? 'yearly' : body.billing.toLowerCase() === 'monthly' ? 'monthly' : 'one_time' } : {}),
        ...(body.covered !== undefined || body.description !== undefined ? { description: body.covered || body.description } : {}),
        ...(inclusionsPayload !== undefined ? { inclusions: inclusionsPayload } : {}),
        ...(body.eligible_job_types !== undefined ? { eligible_job_types: body.eligible_job_types } : body.for ? { eligible_job_types: [body.for] } : {}),
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
      },
    });

    res.json({ ok: true, plan });
  } catch (err: any) {
    logger.error('Failed to update Bee plan:', err);
    res.status(500).json({ error: 'Failed to update warranty plan' });
  }
}

export async function deleteBeePlan(req: Request, res: Response) {
  const user = req.user!;
  const id = req.params.id as string;

  try {
    await prisma.beeWarrantyPlan.deleteMany({
      where: { id, organization_id: user.organization_id },
    });
    res.json({ ok: true });
  } catch (err: any) {
    logger.error('Failed to delete Bee plan:', err);
    res.status(500).json({ error: 'Failed to delete warranty plan' });
  }
}

export async function getJobTypeWarranties(req: Request, res: Response) {
  const user = req.user!;
  try {
    const jobTypeWarranties = await BeeService.getJobTypeWarranties(user.organization_id);
    res.json({ ok: true, jobTypeWarranties });
  } catch (err: any) {
    logger.error('Failed to get job type warranties:', err);
    res.status(500).json({ error: 'Failed to retrieve job type warranties' });
  }
}

export async function updateJobTypeWarranties(req: Request, res: Response) {
  const user = req.user!;
  const { jobTypeWarranties } = req.body;
  try {
    const updated = await BeeService.updateJobTypeWarranties(user.organization_id, jobTypeWarranties);
    res.json({ ok: true, jobTypeWarranties: updated });
  } catch (err: any) {
    logger.error('Failed to update job type warranties:', err);
    res.status(500).json({ error: 'Failed to update job type warranties' });
  }
}

export async function syncBeeWarranties(req: Request, res: Response) {
  const user = req.user!;
  try {
    const result = await BeeService.syncWarrantyRecordsAndQueue(user.organization_id);
    res.json({ ok: true, result });
  } catch (err: any) {
    logger.error('Failed to sync warranties:', err);
    res.status(500).json({ error: 'Failed to sync warranties and queue' });
  }
}

// ─── 6. Do Not Call (DNC) ─────────────────────────────────────────────────────

export async function getBeeDnc(req: Request, res: Response) {
  const user = req.user!;
  try {
    const dncList = await prisma.beeDncEntry.findMany({
      where: { organization_id: user.organization_id },
      orderBy: { created_at: 'desc' },
    });
    res.json({ ok: true, dncList });
  } catch (err: any) {
    logger.error('Failed to get Bee DNC list:', err);
    res.status(500).json({ error: 'Failed to retrieve Do Not Call list' });
  }
}

export const createBeeDncSchema = z.object({
  phone_number: z.string().min(5),
  reason: z.string().optional(),
});

export async function createBeeDnc(req: Request, res: Response) {
  const user = req.user!;
  const { phone_number, reason } = req.body;

  try {
    const entry = await prisma.beeDncEntry.upsert({
      where: {
        organization_id_phone_number: {
          organization_id: user.organization_id,
          phone_number: phone_number.trim(),
        },
      },
      create: {
        organization_id: user.organization_id,
        phone_number: phone_number.trim(),
        reason: reason || 'Manual Admin Entry',
        source: 'manual',
      },
      update: {
        reason: reason || 'Manual Admin Entry',
      },
    });

    res.json({ ok: true, entry });
  } catch (err: any) {
    logger.error('Failed to create DNC entry:', err);
    res.status(500).json({ error: 'Failed to add number to Do Not Call registry' });
  }
}

export async function deleteBeeDnc(req: Request, res: Response) {
  const user = req.user!;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = (typeof rawId === 'string' ? rawId : '').trim();

  if (!id) {
    res.status(400).json({ error: 'Missing entry id or phone number' });
    return;
  }

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const orgIds = [user.organization_id];
  if (user.org_is_demo && user.organization_id !== '00000000-0000-0000-0000-000000000001') {
    orgIds.push('00000000-0000-0000-0000-000000000001');
  }

  try {
    let deletedCount = 0;

    // 1. Try deleting by UUID primary key if valid UUID
    if (isUuid) {
      const result = await prisma.beeDncEntry.deleteMany({
        where: {
          id,
          organization_id: { in: orgIds },
        },
      });
      deletedCount = result.count;
    }

    // 2. If not a UUID or UUID matched 0 rows, try deleting by phone number
    if (deletedCount === 0) {
      const digits = id.replace(/\D/g, '');
      const phoneCandidates = [
        id,
        ...(digits ? [digits, `+${digits}`] : []),
        ...(digits.length === 10 ? [`+1${digits}`, `1${digits}`] : []),
        ...(digits.length === 11 && digits.startsWith('1') ? [digits.slice(1), `+${digits}`] : []),
      ];

      // Try exact matches across candidates
      let result = await prisma.beeDncEntry.deleteMany({
        where: {
          organization_id: { in: orgIds },
          phone_number: { in: phoneCandidates },
        },
      });
      deletedCount = result.count;

      // If still 0 and digits has at least 7 numbers, match by last 10 digits
      if (deletedCount === 0 && digits.length >= 7) {
        const last10 = digits.slice(-10);
        result = await prisma.beeDncEntry.deleteMany({
          where: {
            organization_id: { in: orgIds },
            phone_number: { contains: last10 },
          },
        });
        deletedCount = result.count;
      }
    }

    if (deletedCount === 0) {
      res.status(404).json({ error: 'DNC entry not found or already removed' });
      return;
    }

    res.json({ ok: true, deletedCount });
  } catch (err: any) {
    logger.error('Failed to delete DNC entry:', err);
    res.status(500).json({ error: 'Failed to remove number from Do Not Call registry' });
  }
}

// ─── 7. Setup & Settings ──────────────────────────────────────────────────────

export async function getBeeSettings(req: Request, res: Response) {
  const user = req.user!;
  try {
    let settings = await prisma.beeSetting.findUnique({
      where: { organization_id: user.organization_id },
    });

    if (!settings) {
      settings = await prisma.beeSetting.create({
        data: {
          organization_id: user.organization_id,
          is_active: true,
          call_window_start: '10:00',
          call_window_end: '19:00',
          timezone: 'America/New_York',
          max_retries: 2,
          retry_interval_hours: 48,
          voice_provider: 'vapi',
        },
      });
    }

    res.json({ ok: true, settings });
  } catch (err: any) {
    logger.error('Failed to get Bee settings:', err);
    res.status(500).json({ error: 'Failed to retrieve Bee configuration' });
  }
}

export async function updateBeeSettings(req: Request, res: Response) {
  const user = req.user!;
  const body = req.body;

  try {
    const normalizedJobRules =
      body.job_type_warranties !== undefined
        ? BeeService.normalizeJobTypeWarrantyItems(body.job_type_warranties)
        : undefined;

    const updated = await prisma.beeSetting.upsert({
      where: { organization_id: user.organization_id },
      create: {
        organization_id: user.organization_id,
        is_active: body.is_active ?? true,
        call_window_start: body.call_window_start || '10:00',
        call_window_end: body.call_window_end || '19:00',
        timezone: body.timezone || 'America/New_York',
        max_retries: body.max_retries ?? 2,
        retry_interval_hours: body.retry_interval_hours ?? 48,
        default_lead_owner_id: body.default_lead_owner_id || null,
        alert_email: body.alert_email || null,
        alert_phone: body.alert_phone || null,
        voice_provider: body.voice_provider || 'vapi',
        voice_provider_api_key: body.voice_provider_api_key || null,
        job_type_warranties: normalizedJobRules || [],
        setup_config: body.setup_config || {},
      } as any,
      update: {
        ...(body.is_active !== undefined ? { is_active: body.is_active } : {}),
        ...(body.call_window_start !== undefined ? { call_window_start: body.call_window_start } : {}),
        ...(body.call_window_end !== undefined ? { call_window_end: body.call_window_end } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
        ...(body.max_retries !== undefined ? { max_retries: body.max_retries } : {}),
        ...(body.retry_interval_hours !== undefined ? { retry_interval_hours: body.retry_interval_hours } : {}),
        ...(body.default_lead_owner_id !== undefined ? { default_lead_owner_id: body.default_lead_owner_id } : {}),
        ...(body.alert_email !== undefined ? { alert_email: body.alert_email } : {}),
        ...(body.alert_phone !== undefined ? { alert_phone: body.alert_phone } : {}),
        ...(body.voice_provider !== undefined ? { voice_provider: body.voice_provider } : {}),
        ...(body.voice_provider_api_key !== undefined
          ? { voice_provider_api_key: body.voice_provider_api_key }
          : {}),
        ...(normalizedJobRules !== undefined ? { job_type_warranties: normalizedJobRules } : {}),
        ...(body.setup_config !== undefined ? { setup_config: body.setup_config } : {}),
      } as any,
    });

    res.json({ ok: true, settings: updated });
  } catch (err: any) {
    logger.error('Failed to update Bee settings:', err);
    res.status(500).json({ error: 'Failed to update Bee configuration' });
  }
}

// ─── 8. Inbound Webhook ───────────────────────────────────────────────────────

export const beeWebhookSchema = z
  .object({
    callId: z.string().optional(),
    call_id: z.string().optional(),
    transcript: z.union([
      z.string().min(1, 'Transcript cannot be empty'),
      z
        .array(
          z.object({
            speaker: z.string(),
            text: z.string(),
            timestamp: z.number().optional(),
          })
        )
        .min(1, 'Transcript turns cannot be empty'),
    ]),
    recordingUrl: z.string().url('Recording URL must be a valid URL').optional(),
    recording_url: z.string().url('Recording URL must be a valid URL').optional(),
    audio_url: z.string().url('Audio URL must be a valid URL').optional(),
    status: z.string().optional(),
    outcome: z.string().optional(),
    duration_seconds: z.number().int().nonnegative().optional(),
    duration: z.number().int().nonnegative().optional(),
    ai_summary: z.string().optional(),
    summary: z.string().optional(),
    customer_id: z.string().optional(),
    customerId: z.string().optional(),
    customer_name: z.string().optional(),
    customerName: z.string().optional(),
    customer_phone: z.string().optional(),
    customerPhone: z.string().optional(),
    agent_id: z.string().optional(),
    agentId: z.string().optional(),
    queue_item_id: z.string().optional(),
    queueItemId: z.string().optional(),
    needs_human_alert: z.boolean().optional(),
    cost_estimate: z.number().optional(),
  })
  .refine(
    (data) => Boolean(data.recordingUrl || data.recording_url || data.audio_url),
    {
      message: 'A valid recording URL (recordingUrl, recording_url, or audio_url) is required',
      path: ['recordingUrl'],
    }
  );

export async function receiveBeeWebhook(req: Request, res: Response) {
  const user = req.user!;
  try {
    const result = await BeeService.processInboundCall(user.organization_id, req.body);
    const statusCode = result.isNew ? 201 : 200;
    res.status(statusCode).json({
      ok: true,
      message: result.isNew
        ? 'Bee call webhook processed successfully'
        : 'Call log updated (idempotent)',
      callId: result.callLog.id,
      idempotent: result.idempotent,
      leadId: result.leadId || result.callLog.lead_id || null,
      call: result.callLog,
    });
  } catch (err: any) {
    logger.error('Failed to process Bee webhook:', err);
    res.status(500).json({ error: 'Failed to process inbound call webhook' });
  }
}

/**
 * Receives native Voice Calling Engine webhook payloads (Way 1: e.g. Vapi `end-of-call-report`)
 * and runs Stage 1 Call Result Ingestion (`BeeService.ingestCallResultStageOne`) to update
 * the existing `bee_call_logs` row with the recording URL and timestamped transcript.
 */
export async function receiveVoiceEngineWebhook(req: Request, res: Response) {
  const user = req.user!;
  try {
    const parsed = await BeeVoiceAdapter.parseEngineWebhook(user.organization_id, req.body);
    if (!parsed) {
      // Non-end-of-call lifecycle event (e.g. assistant-request, speech-update, hang); acknowledge 200 OK
      return res.status(200).json({
        ok: true,
        ignored: true,
        message: 'Lifecycle event acknowledged (awaiting end-of-call-report)',
      });
    }

    const targetOrgId = parsed.metadata?.organizationId || user.organization_id;
    const result = await BeeService.ingestCallResultStageOne(targetOrgId, parsed);
    const statusCode = result.isNew ? 201 : 200;

    return res.status(statusCode).json({
      ok: true,
      stage: 'stage_1_ingested',
      message: result.isNew
        ? 'Voice engine call result logged (Stage 1)'
        : 'Existing call log updated with recording and timestamped transcript (Stage 1)',
      callId: result.callLog.id,
      idempotent: result.idempotent,
      call: result.callLog,
    });
  } catch (err: any) {
    logger.error('Failed to process Voice Engine webhook:', err);
    return res.status(500).json({ error: 'Failed to process voice engine webhook' });
  }
}

/**
 * Synchronizes any pending/recent completed calls from the active Voice Calling Engine into `bee_call_logs`.
 */
export async function syncBeeCallLogs(req: Request, res: Response) {
  const user = req.user!;
  try {
    await BeeService.reconcilePendingCallLogs(user.organization_id);
    res.json({ ok: true, message: 'Call logs synchronized with Voice Calling Engine' });
  } catch (err: any) {
    logger.error('Failed to sync Bee call logs:', err);
    res.status(500).json({ error: 'Failed to sync call logs' });
  }
}

/**
 * 8. Bee Dedicated Phone System endpoints
 */
export async function getBeePhoneNumbers(req: Request, res: Response) {
  const user = req.user!;
  try {
    const phoneNumbers = await BeeService.getAvailablePhoneNumbers(user.organization_id);
    res.json({ ok: true, phoneNumbers });
  } catch (err: any) {
    logger.error('Failed to get Bee phone numbers:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Failed to fetch phone numbers' });
  }
}

export async function buyBeePhoneNumber(req: Request, res: Response) {
  const user = req.user!;
  try {
    const { areaCode, name, provider, number } = req.body || {};
    const phoneNumber = await BeeVoiceAdapter.buyPhoneNumber(user.organization_id, {
      areaCode: areaCode ? String(areaCode).trim() : undefined,
      name: name ? String(name).trim() : 'Bee Outbound Line',
      provider: provider || 'vapi',
      number: number ? String(number).trim() : undefined,
    });
    res.json({ ok: true, phoneNumber });
  } catch (err: any) {
    logger.error('Failed to buy Bee phone number:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Failed to provision phone number' });
  }
}

export async function releaseBeePhoneNumber(req: Request, res: Response) {
  const user = req.user!;
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ ok: false, error: 'Phone number ID is required' });
    }
    const result = await BeeVoiceAdapter.releasePhoneNumber(user.organization_id, String(id));
    if (!result.success) {
      return res.status(400).json({ ok: false, error: result.error || 'Failed to release phone number' });
    }
    res.json({ ok: true, released: true });
  } catch (err: any) {
    logger.error('Failed to release Bee phone number:', err);
    res.status(500).json({ ok: false, error: err?.message || 'Failed to release phone number' });
  }
}

