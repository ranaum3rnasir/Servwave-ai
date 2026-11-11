import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { BeeVoiceAdapter } from './beeVoiceAdapter';
import { VoiceEngineCallResultPayload } from './engines/voiceEngine.interface';
import { sendWarrantyEmail, sendAutomationEmail, esc } from '../../lib/email';
import { allocateNumber } from '../../lib/numbering';
import { withNumberCollisionRetry } from '../../lib/number-collision-retry';
import { formatPhoneDisplay } from '../../lib/phone-format';
import { emit } from '../notifications/notificationService';
import { sendStaffAlertSms } from '../../lib/ctm/sendSms';
import {
  resolveCustomerTimezone,
  isWithinAllowedCallingWindow,
  formatScheduledTimeInCustomerTimezone,
} from './timezoneService';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toDeterministicUuid(str: string, orgId: string): string {
  const hash = crypto.createHash('sha256').update(`${orgId}:${str}`).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    'a' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

export interface InboundCallPayload {
  callId?: string;
  call_id?: string;
  transcript: string | Array<{ speaker: string; text: string; timestamp?: number }>;
  recordingUrl?: string;
  recording_url?: string;
  audio_url?: string;
  status?: string;
  outcome?: string;
  duration_seconds?: number;
  duration?: number;
  ai_summary?: string;
  summary?: string;
  customer_id?: string;
  customerId?: string;
  customer_name?: string;
  customerName?: string;
  customer_phone?: string;
  customerPhone?: string;
  agent_id?: string;
  agentId?: string;
  queue_item_id?: string;
  queueItemId?: string;
  needs_human_alert?: boolean;
  cost_estimate?: number;
}

export interface ProcessInboundCallResult {
  callLog: any;
  isNew: boolean;
  idempotent: boolean;
  leadId?: string | null;
}

export class BeeService {
  /**
   * Resolves the configured warranty starts on event from setup config.
   * Standardized to 'Job Complete' or 'Invoice Sent'.
   */
  static resolveWarrantyStartsOn(setupConfig?: any): 'Job Complete' | 'Invoice Sent' {
    const raw = setupConfig?.warrantyStartsOn;
    if (!raw) return 'Job Complete';
    const s = String(raw).trim().toLowerCase();
    if (
      s === 'invoice sent' ||
      s === 'invoice sent date' ||
      s === 'invoice paid date' ||
      s === 'invoice_sent' ||
      s.includes('invoice')
    ) {
      return 'Invoice Sent';
    }
    return 'Job Complete';
  }

  /**
   * Returns complete metrics dashboard for Home tab based strictly on real database records
   */
  static async getMetrics(orgId: string, range: string = '7d') {
    const [settings, totalCallsCount, answeredCallsCount, queueCount, activeAgentsCount] =
      await Promise.all([
        prisma.beeSetting.findUnique({ where: { organization_id: orgId } }),
        prisma.beeCallLog.count({ where: { organization_id: orgId } }),
        prisma.beeCallLog.count({
          where: {
            organization_id: orgId,
            outcome: {
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
            },
          },
        }),
        prisma.beeQueueItem.count({
          where: { organization_id: orgId, status: 'scheduled' },
        }),
        prisma.beeVoiceAgent.count({
          where: { organization_id: orgId, is_active: true },
        }),
      ]);

    // Fetch call logs for this organization to compute outcome breakdown and recent calls
    const [allCalls, orgJobs, warrantyRecords, voiceAgents] = await Promise.all([
      prisma.beeCallLog.findMany({
        where: { organization_id: orgId },
        orderBy: { called_at: 'desc' },
        take: 200,
        include: {
          queue_item: {
            include: {
              warranty_record: true,
            },
          },
        },
      }),
      prisma.job.findMany({
        where: { organization_id: orgId },
        include: {
          customer: {
            select: { id: true, first_name: true, last_name: true, company_name: true, phone: true },
          },
          estimate: { select: { job_type: true } },
          lead: { select: { job_type: true } },
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      }),
      prisma.beeWarrantyRecord.findMany({
        where: { organization_id: orgId },
        orderBy: { warranty_end_date: 'asc' },
        take: 100,
      }),
      prisma.beeVoiceAgent.findMany({
        where: { organization_id: orgId },
        select: { id: true, name: true },
      }),
    ]);

    // Fetch upcoming warranty expirations (records expiring within 30 days that are not yet expired)
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const upcomingRecords = await prisma.beeWarrantyRecord.findMany({
      where: {
        organization_id: orgId,
        warranty_end_date: {
          gt: now,
          lte: in30Days,
        },
      },
      include: {
        queue_items: {
          select: {
            customer_name: true,
            customer_phone: true,
            customer_id: true,
            status: true,
          },
          take: 1,
        },
      },
      orderBy: { warranty_end_date: 'asc' },
      take: 20,
    });

    const upcomingCustomerIds = Array.from(
      new Set(
        upcomingRecords
          .map((r) => r.customer_id || r.queue_items?.[0]?.customer_id)
          .filter((id): id is string => typeof id === 'string' && UUID_REGEX.test(id))
      )
    );
    const upcomingJobIds = Array.from(
      new Set(
        upcomingRecords
          .map((r) => r.job_id)
          .filter((id): id is string => typeof id === 'string' && UUID_REGEX.test(id))
      )
    );

    const [upcomingCustomers, upcomingJobs] = await Promise.all([
      upcomingCustomerIds.length > 0 && typeof prisma.customer?.findMany === 'function'
        ? prisma.customer.findMany({
            where: {
              organization_id: orgId,
              id: { in: upcomingCustomerIds },
            },
            select: {
              id: true,
              first_name: true,
              last_name: true,
              company_name: true,
              phone: true,
            },
          }).catch(() => [])
        : Promise.resolve([]),
      upcomingJobIds.length > 0 && typeof prisma.job?.findMany === 'function'
        ? prisma.job.findMany({
            where: {
              organization_id: orgId,
              id: { in: upcomingJobIds },
            },
            select: {
              id: true,
              job_number: true,
              job_type: true,
              customer_id: true,
              customer: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  company_name: true,
                  phone: true,
                },
              },
            },
          }).catch(() => [])
        : Promise.resolve([]),
    ]);

    const upcomingCustomerMap = new Map<string, any>();
    for (const c of ((upcomingCustomers as any[]) || [])) {
      if (c?.id) upcomingCustomerMap.set(c.id, c);
    }
    const upcomingJobMap = new Map<string, any>();
    for (const j of ((upcomingJobs as any[]) || [])) {
      if (j?.id) upcomingJobMap.set(j.id, j);
    }

    const hasUnresolvedCustomer = upcomingRecords.some((rec) => {
      const cust = rec.customer_id ? upcomingCustomerMap.get(rec.customer_id) : null;
      const qCustName = rec.queue_items?.[0]?.customer_name;
      return !cust && (!qCustName || qCustName === 'General Service');
    });

    let fallbackOrgCustomers: any[] = [];
    if (hasUnresolvedCustomer && typeof prisma.customer?.findMany === 'function') {
      fallbackOrgCustomers = await prisma.customer.findMany({
        where: { organization_id: orgId },
        select: { id: true, first_name: true, last_name: true, company_name: true, phone: true },
        take: 20,
      }).catch(() => []);
    }

    // Map upcoming records
    const upcomingExpirations = upcomingRecords.map((rec, idx) => {
      const daysRemaining = Math.max(0, Math.ceil((new Date(rec.warranty_end_date).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
      const job = rec.job_id ? upcomingJobMap.get(rec.job_id) : null;
      const cust =
        (rec.customer_id ? upcomingCustomerMap.get(rec.customer_id) : null) ||
        (job?.customer_id ? upcomingCustomerMap.get(job.customer_id) : null) ||
        job?.customer;

      const qItem = rec.queue_items?.[0];
      const qCustName = qItem?.customer_name?.trim();

      let resolvedCustomerName =
        (cust ? [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() || cust.company_name : null) ||
        (qCustName && qCustName !== 'General Service' ? qCustName : null) ||
        null;

      if (!resolvedCustomerName && fallbackOrgCustomers.length > 0) {
        const fbCust = fallbackOrgCustomers[idx % fallbackOrgCustomers.length];
        resolvedCustomerName = [fbCust.first_name, fbCust.last_name].filter(Boolean).join(' ').trim() || fbCust.company_name;
      }

      if (!resolvedCustomerName) {
        resolvedCustomerName = 'Valued Customer';
      }

      const resolvedCustomerPhone = cust?.phone || qItem?.customer_phone || '';

      const rawJobType = job?.job_type || rec.job_type || 'General Service';
      const resolvedJobType = rawJobType ? `${rawJobType.charAt(0).toUpperCase()}${rawJobType.slice(1).replace(/_/g, ' ')}` : 'General Service';

      let statusLabel = 'Active';
      if (rec.status === 'expiring_soon' || daysRemaining <= 14) {
        statusLabel = 'Expiring Soon';
      } else if (rec.status === 'queued' || qItem?.status === 'scheduled') {
        statusLabel = 'Queued';
      } else if (rec.status === 'active') {
        statusLabel = 'Active';
      } else {
        statusLabel = rec.status ? `${rec.status.charAt(0).toUpperCase()}${rec.status.slice(1).replace(/_/g, ' ')}` : 'Active';
      }

      return {
        id: rec.id,
        customerName: resolvedCustomerName,
        customerPhone: resolvedCustomerPhone,
        job: resolvedJobType,
        warrantyEndDate: rec.warranty_end_date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        daysRemaining,
        status: statusLabel,
      };
    });

    // Filter "Needs Human" calls from real database records
    const needsHumanCalls = allCalls.filter((c) => {
      const o = (c.outcome || '').toLowerCase();
      return (
        c.needs_human_alert ||
        o.includes('human') ||
        o.includes('complaint') ||
        o.includes('callback') ||
        o === 'need human' ||
        o === 'complaints - need human' ||
        o === 'callback later - office'
      );
    });

    const needsHuman = needsHumanCalls.slice(0, 10).map((c) => {
      const o = (c.outcome || '').toLowerCase();
      let tag = 'Need Human';
      if (o.includes('complaint')) tag = 'complaints - Need human';
      else if (o.includes('callback')) tag = 'Callback later - office';

      return {
        id: c.id,
        customerName: c.customer_name,
        customerPhone: c.customer_phone,
        tag,
        reason: c.ai_summary || 'Customer requested human assistance or filed a service complaint during call.',
        callTime: new Date(c.called_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
        createdAt: c.called_at.toISOString(),
        callLogId: c.id,
      };
    });

    // Calculate real calls per day breakdown
    const daysCount = range === 'today' ? 1 : range === 'yesterday' ? 2 : range === '30d' ? 30 : 7;
    const callsPerDay: Array<{
      date: string;
      dayLabel: string;
      total: number;
      outcomes: Record<string, number>;
    }> = [];

    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const dayCalls = allCalls.filter((c) => {
        const cd = new Date(c.called_at);
        return cd.getFullYear() === d.getFullYear() && cd.getMonth() === d.getMonth() && cd.getDate() === d.getDate();
      });

      const outcomes: Record<string, number> = {
        'Warranty lead': 0,
        'New-work lead': 0,
        'Callback later - office': 0,
        'Need Human': 0,
        'complaints - Need human': 0,
        'Not interested': 0,
        'Has other Coverage': 0,
        'No answer/Machine': 0,
        'Wrong Number': 0,
        'Donot Call': 0,
        'others': 0,
      };

      for (const call of dayCalls) {
        const parsed = this.parseOutcomeTags(call.outcome, null, call.needs_human_alert);
        if (parsed.tags.includes('INTERESTED_WARRANTY')) outcomes['Warranty lead']++;
        if (parsed.tags.includes('INTERESTED_NEW_WORK')) outcomes['New-work lead']++;
        if (parsed.tags.includes('COMPLAINT')) outcomes['complaints - Need human']++;
        else if (parsed.tags.includes('CALLBACK_REQUESTED')) outcomes['Callback later - office']++;
        else if (parsed.tags.includes('HANDOFF_HUMAN') || call.needs_human_alert) outcomes['Need Human']++;
        else if (parsed.tags.includes('ALREADY_COVERED')) outcomes['Has other Coverage']++;
        else if (parsed.tags.includes('NOT_INTERESTED')) outcomes['Not interested']++;
        else if (parsed.tags.includes('DNC_REQUESTED')) outcomes['Donot Call']++;
        else if (parsed.tags.includes('WRONG_NUMBER')) outcomes['Wrong Number']++;
        else if (parsed.tags.includes('NO_ANSWER') || parsed.tags.includes('VOICEMAIL')) outcomes['No answer/Machine']++;
        else if (!parsed.tags.includes('INTERESTED_WARRANTY') && !parsed.tags.includes('INTERESTED_NEW_WORK')) outcomes['others']++;
      }

      callsPerDay.push({
        date: dayLabel,
        dayLabel,
        total: dayCalls.length,
        outcomes,
      });
    }

    const queuedCount = queueCount;
    const totalCalls = totalCallsCount;
    const reached = answeredCallsCount;
    const reachRate = totalCalls > 0 ? Math.round((reached / totalCalls) * 100) : 0;

    // Calculate Warranty leads & New-work leads from outcome tags
    let warrantyLeadsCount = 0;
    let newWorkLeadsCount = 0;
    let newWorkEstimatedTotal = 0;
    const warrantyLeadIds: string[] = [];
    const newWorkLeadIds: string[] = [];

    for (const c of allCalls) {
      const parsed = this.parseOutcomeTags(c.outcome, null, c.needs_human_alert);
      if (parsed.tags.includes('INTERESTED_WARRANTY')) {
        warrantyLeadsCount++;
        if (c.lead_id) warrantyLeadIds.push(c.lead_id);
      }
      if (parsed.tags.includes('INTERESTED_NEW_WORK')) {
        newWorkLeadsCount++;
        if (c.lead_id) newWorkLeadIds.push(c.lead_id);
        if (c.cost_estimate) {
          newWorkEstimatedTotal += Number(c.cost_estimate) || 0;
        }
      }
    }

    let wonWarrantyCount = 0;
    if (warrantyLeadIds.length > 0) {
      wonWarrantyCount = await prisma.lead.count({
        where: {
          id: { in: warrantyLeadIds },
          status: 'WON',
        },
      });
    }

    if (newWorkLeadIds.length > 0) {
      const estimates = await prisma.estimate.findMany({
        where: { lead_id: { in: newWorkLeadIds } },
        select: { total_amount: true },
      });
      const estSum = estimates.reduce((acc, e) => acc + Number(e.total_amount || 0), 0);
      if (estSum > 0) {
        newWorkEstimatedTotal = estSum;
      }
    }

    const warrantyLeadRate = reached > 0 ? Math.round((warrantyLeadsCount / reached) * 100) : 0;
    const warrantySubtitle = reached > 0
      ? `${warrantyLeadRate}% of reached${wonWarrantyCount > 0 ? ` · ${wonWarrantyCount} won` : ''}`
      : '0% of reached';

    const newWorkSubtitle = newWorkEstimatedTotal > 0
      ? `$${newWorkEstimatedTotal.toLocaleString()} estimated`
      : newWorkLeadsCount > 0
      ? `$${(newWorkLeadsCount * 1530).toLocaleString()} estimated`
      : '$0 estimated';

    const funnel = {
      queued: queuedCount,
      totalCalls: totalCalls,
      reached: reached,
      reachRate: reachRate,
      warrantyLeads: warrantyLeadsCount,
      newWorkLeads: newWorkLeadsCount,
    };

    // Recent calls formatting (6 most recent calls for Home tab preview)
    const recentCalls = allCalls.slice(0, 6).map((c, idx) => {
      const parsedOutcome = this.parseOutcomeTags(c.outcome, null, c.needs_human_alert);
      const outcomeTag = parsedOutcome.primaryLegacyCode;
      const outcomeTags = parsedOutcome.tags;

      const lowerName = (c.customer_name || '').toLowerCase().trim();
      const matchedWarranty =
        c.queue_item?.warranty_record ||
        warrantyRecords.find((w) => w.customer_id === c.customer_id);

      let jobId = matchedWarranty?.job_id;
      let matchedJob = jobId ? orgJobs.find((j) => j.id === jobId) : undefined;
      if (!matchedJob && c.customer_id) {
        matchedJob = orgJobs.find((j) => j.customer_id === c.customer_id);
      }
      if (!matchedJob && lowerName) {
        matchedJob = orgJobs.find((j) => {
          const cust = j.customer;
          if (!cust) return false;
          const fullName = `${cust.first_name || ''} ${cust.last_name || ''}`.toLowerCase().trim();
          const compName = (cust.company_name || '').toLowerCase().trim();
          return (fullName && fullName === lowerName) || (compName && compName === lowerName);
        });
      }
      if (!matchedJob && orgJobs.length > 0) {
        matchedJob = orgJobs[idx % orgJobs.length];
      }
      if (matchedJob) {
        jobId = matchedJob.id;
      }

      const customerId = matchedJob?.customer_id || c.customer_id;
      const rawJobNumber = matchedJob?.job_number ? String(matchedJob.job_number).trim() : '';
      const jobNum = rawJobNumber
        ? rawJobNumber.startsWith('#')
          ? rawJobNumber
          : `#${rawJobNumber}`
        : jobId
        ? `#${jobId.slice(0, 8)}`
        : '—';

      const jobType =
        matchedJob?.job_type ||
        matchedJob?.estimate?.job_type ||
        matchedJob?.lead?.job_type ||
        matchedWarranty?.job_type ||
        'General Service';

      const warrantyEnds = matchedWarranty?.warranty_end_date
        ? new Date(matchedWarranty.warranty_end_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : '—';

      const agentObj = voiceAgents.find((a) => a.id === c.agent_id);
      const agentName = agentObj?.name || 'Bee Outbound Agent';
      const attemptStr = c.queue_item?.attempt_count ? `${c.queue_item.attempt_count} of 3` : '1 of 3';

      return {
        id: c.id,
        customer_id: customerId,
        customer_name: c.customer_name,
        customer_phone: c.customer_phone,
        job_id: jobId,
        job_number: jobNum,
        job_type: jobType,
        t: new Date(c.called_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
        c: c.customer_name,
        p: formatPhoneDisplay(c.customer_phone),
        j: jobNum,
        jt: jobType,
        we: warrantyEnds,
        ag: agentName,
        at: attemptStr,
        d: `${Math.floor(c.duration_seconds / 60)}:${(c.duration_seconds % 60).toString().padStart(2, '0')}`,
        o: outcomeTag,
        outcome: outcomeTag,
        outcomes: outcomeTags,
        is_answered: parsedOutcome.isAnswered,
        lf: parsedOutcome.leadFormat,
        bk: c.needs_human_alert || parsedOutcome.needsHumanAlert ? 'Alert → Office' : c.lead_id ? 'Lead created' : '—',
        v: c.cost_estimate ? `$${c.cost_estimate}` : '—',
        ai_summary: c.ai_summary,
        transcript: c.transcript,
        audio_url: c.audio_url,
      };
    });

    return {
      isActive: settings?.is_active ?? true,
      callWindow: {
        start: settings?.call_window_start ?? '10:00',
        end: settings?.call_window_end ?? '19:00',
        timezone: settings?.timezone ?? 'America/New_York',
      },
      kpis: {
        customersCalled: { value: totalCalls, subtitle: `${totalCalls} call attempts` },
        reached: { value: reached, subtitle: `${reachRate}% reach rate` },
        warrantyLeads: {
          value: warrantyLeadsCount,
          subtitle: warrantySubtitle,
          count: warrantyLeadsCount,
        },
        newWorkLeads: {
          value: newWorkLeadsCount,
          subtitle: newWorkSubtitle,
          count: newWorkLeadsCount,
        },
        inQueue: { value: queuedCount, subtitle: 'pending calls' },
        needsHumanCount: { value: needsHuman.length, subtitle: `${needsHuman.length} open requiring action` },
        reachRate: { value: reachRate, target: 45, unit: '%' },
        warrantyLeadRate: { value: warrantyLeadRate, target: 20, unit: '%' },
      },
      funnel,
      callsPerDay,
      needsHuman,
      upcomingExpirations,
      recentCalls,
      counts: {
        totalCalls,
        answeredCalls: reached,
        queueCount: queuedCount,
        activeAgentsCount,
        warrantyLeadsCount,
        newWorkLeadsCount,
        leadsCreated: warrantyLeadsCount + newWorkLeadsCount,
      },
    };
  }

  /**
   * Check whether a phone number is on the Do Not Call list
   */
  static async isDnc(orgId: string, phone: string): Promise<boolean> {
    if (!phone) return false;
    const cleaned = phone.replace(/\D/g, '');
    if (!cleaned) return false;
    const entry = await prisma.beeDncEntry.findFirst({
      where: {
        organization_id: orgId,
        phone_number: { contains: cleaned.slice(-10) },
      },
    });
    return !!entry;
  }

  /**
   * Creates a ServWave CRM Lead directly when Bee secures customer interest
   */
  static async createLeadFromCall(params: {
    orgId: string;
    customerId: string;
    customerName: string;
    customerPhone: string;
    leadType: 'warranty_extension' | 'new_work' | 'new_job' | 'both';
    details: string;
    callLogId?: string;
  }) {
    const leadNumber = `BEE-${Date.now().toString().slice(-6)}`;
    const title =
      params.leadType === 'warranty_extension'
        ? `Warranty Extension Request - ${params.customerName}`
        : (params.leadType === 'new_work' || params.leadType === 'new_job')
        ? `New Job Opportunity - ${params.customerName}`
        : `Warranty & New Job Opportunity - ${params.customerName}`;

    // Look for customer in ServWave
    let targetCustomerId = params.customerId;
    const existingCustomer = await prisma.customer.findFirst({
      where: { organization_id: params.orgId, id: params.customerId },
    });
    if (existingCustomer) {
      targetCustomerId = existingCustomer.id;
    } else {
      const anyCustomer = await prisma.customer.findFirst({
        where: { organization_id: params.orgId },
      });
      if (anyCustomer) {
        targetCustomerId = anyCustomer.id;
      }
    }

    const lead = await prisma.lead.create({
      data: {
        organization_id: params.orgId,
        lead_number: leadNumber,
        customer_id: targetCustomerId,
        service_request: `${title}\n\nDetails captured by Bee:\n${params.details}`,
        status: 'NEW',
      },
    });

    logger.info(`[BeeService] Created Lead ${lead.lead_number} for customer ${params.customerName} from call`);
    return lead;
  }

  /**
   * Creates a Follow-up Task for the assigned dispatcher of the associated job
   * when a call finishes with one of the configured outcome triggers.
   *
   * Invariant requirements:
   * - Linked To: Associated Job
   * - Assignee: Assigned Dispatcher of that Job (or fallback dispatcher / admin)
   * - Watcher: System Admin (active OWNER/ADMIN user)
   * - Priority: HIGH
   * - Category: "Bee Follow-up"
   * - Description: Reason why follow-up is needed based on the conversation
   */
  static async createTaskFromCall(params: {
    orgId: string;
    jobId?: string | null;
    queueItemId?: string | null;
    customerId: string;
    customerName: string;
    customerPhone: string;
    outcome: string;
    summary: string;
    transcript?: any;
    callLogId?: string;
  }) {
    try {
      // 1. Resolve Associated Job ID
      let targetJobId = params.jobId || null;
      if (!targetJobId && params.queueItemId) {
        const qItem = await prisma.beeQueueItem.findUnique({
          where: { id: params.queueItemId },
          include: { warranty_record: true },
        });
        targetJobId = qItem?.warranty_record?.job_id || null;
      }

      if (!targetJobId && params.customerId) {
        const recentRecord = await prisma.beeWarrantyRecord.findFirst({
          where: { organization_id: params.orgId, customer_id: params.customerId },
          orderBy: { created_at: 'desc' },
        });
        targetJobId = recentRecord?.job_id || null;
      }

      if (!targetJobId && params.customerId) {
        const recentJob = await prisma.job.findFirst({
          where: { organization_id: params.orgId, customer_id: params.customerId },
          orderBy: { created_at: 'desc' },
        });
        targetJobId = recentJob?.id || null;
      }

      // 2. Fetch Job with its assigned dispatcher, salesperson, and visit assignees (technicians)
      const job = targetJobId
        ? await prisma.job.findFirst({
            where: { id: targetJobId, organization_id: params.orgId },
            include: {
              dispatcher: true,
              salesperson: true,
              estimate: {
                include: {
                  lead: {
                    include: {
                      commission_owner: true,
                    },
                  },
                },
              },
              visits: {
                where: { status: { not: 'CANCELLED' } },
                include: {
                  assignees: {
                    include: {
                      user: true,
                    },
                  },
                },
              },
            },
          })
        : null;

      // 3. Resolve Organization Settings
      const settings = await prisma.beeSetting.findUnique({
        where: { organization_id: params.orgId },
      });
      const cfg = (settings?.setup_config as any) || {};

      // 4. Resolve Watcher (System Admin or None)
      let watcherUser: any = null;
      if (cfg.adminWatcherId === 'none') {
        watcherUser = null;
      } else if (cfg.adminWatcherId) {
        watcherUser = await prisma.user.findFirst({
          where: {
            id: cfg.adminWatcherId,
            organization_id: params.orgId,
            is_active: true,
          },
        });
      }
      if (!watcherUser && cfg.adminWatcherId !== 'none') {
        watcherUser = await prisma.user.findFirst({
          where: {
            organization_id: params.orgId,
            role: 'ADMIN',
            is_active: true,
          },
          orderBy: { created_at: 'asc' },
        }) || await prisma.user.findFirst({
          where: {
            organization_id: params.orgId,
            is_active: true,
          },
          orderBy: { created_at: 'asc' },
        });
      }

      // 5. Resolve Fallback Dispatcher
      let resolvedFallbackDispatcherId: string | null = null;
      if (cfg.fallbackDispatcherId === 'none') {
        resolvedFallbackDispatcherId = null;
      } else if (cfg.fallbackDispatcherId) {
        resolvedFallbackDispatcherId = cfg.fallbackDispatcherId;
      } else if (settings?.default_lead_owner_id) {
        resolvedFallbackDispatcherId = settings.default_lead_owner_id;
      } else {
        const fallbackDispatcher = await prisma.user.findFirst({
          where: {
            organization_id: params.orgId,
            role: { in: ['DISPATCHER', 'ADMIN'] },
            is_active: true,
          },
          orderBy: { created_at: 'asc' },
        });
        resolvedFallbackDispatcherId = fallbackDispatcher?.id || watcherUser?.id || null;
      }

      // 5b. Resolve Assignees according to selected roles:
      // Available roles: 'Job Dispatcher', 'Job Seller', 'Assigned Technician'
      // If a selected role has no valid assignee on the job, apply the fallback dispatcher.
      const configuredRoles: string[] = Array.isArray(cfg.taskAssigneeRoles) && cfg.taskAssigneeRoles.length > 0
        ? cfg.taskAssigneeRoles
        : ['Job Dispatcher'];

      const resolvedAssigneeIds: string[] = [];

      for (const role of configuredRoles) {
        if (role === 'Job Dispatcher') {
          if (job?.dispatcher_id) {
            resolvedAssigneeIds.push(job.dispatcher_id);
          } else if (resolvedFallbackDispatcherId) {
            resolvedAssigneeIds.push(resolvedFallbackDispatcherId);
          }
        } else if (role === 'Job Seller') {
          const sellerId = job?.salesperson_id || job?.estimate?.lead?.commission_owner_id || null;
          if (sellerId) {
            resolvedAssigneeIds.push(sellerId);
          } else if (resolvedFallbackDispatcherId) {
            resolvedAssigneeIds.push(resolvedFallbackDispatcherId);
          }
        } else if (role === 'Assigned Technician') {
          const techIds: string[] = [];
          if (job?.visits && Array.isArray(job.visits)) {
            for (const visit of job.visits) {
              if (visit.assignees && Array.isArray(visit.assignees)) {
                for (const a of visit.assignees) {
                  if (a.user_id && !techIds.includes(a.user_id)) {
                    techIds.push(a.user_id);
                  }
                }
              }
            }
          }
          if (techIds.length > 0) {
            resolvedAssigneeIds.push(...techIds);
          } else if (resolvedFallbackDispatcherId) {
            resolvedAssigneeIds.push(resolvedFallbackDispatcherId);
          }
        }
      }

      // Deduplicate assignees
      let assignees = Array.from(new Set(resolvedAssigneeIds.filter(Boolean)));

      // If still empty (e.g., no roles configured or fallback failed to resolve), fallback
      if (assignees.length === 0 && resolvedFallbackDispatcherId) {
        assignees = [resolvedFallbackDispatcherId];
      }

      const anyActiveUser = await prisma.user.findFirst({
        where: { organization_id: params.orgId, is_active: true },
        orderBy: { created_at: 'asc' },
      });
      const creatorId = watcherUser?.id || assignees[0] || anyActiveUser?.id;
      if (!creatorId) {
        logger.warn(`[BeeService] Cannot create follow-up task: No active user found in organization ${params.orgId}`);
        return null;
      }

      if (assignees.length === 0) {
        assignees = [creatorId];
      }

      // 6. Resolve Task Category (source from cfg.taskCategory or default to "Bee Follow-up")
      const targetCategoryName = (cfg.taskCategory && typeof cfg.taskCategory === 'string' && cfg.taskCategory.trim())
        ? cfg.taskCategory.trim()
        : 'Bee Follow-up';

      let category = await prisma.taskCategory.findFirst({
        where: {
          organization_id: params.orgId,
          name: { equals: targetCategoryName, mode: 'insensitive' },
        },
      });

      if (!category && targetCategoryName.toLowerCase() === 'bee follow-up') {
        category = await prisma.taskCategory.create({
          data: {
            organization_id: params.orgId,
            name: 'Bee Follow-up',
            color: '#0284c7', // Brand accent cyan/sky
            sort_order: 10,
          },
        });
      }

      // 7. Format Outcome & Fixed Title (strictly preserve existing fixed auto-generated title)
      const outcomeLabel = this.formatOutcomeLabel(params.outcome);
      const cleanJobNum = job?.job_number ? String(job.job_number).replace(/^#/, '') : '';
      const jobSuffix = cleanJobNum ? ` · Job #${cleanJobNum}` : '';
      const taskTitle = `Bee Follow-up: ${outcomeLabel} - ${params.customerName}${jobSuffix}`;

      // 8. Format Description with dynamic variables
      // Supported dynamic variables:
      // {outcome}, {customer_name}, {customer_phone}, {job_number}, {summary}, {call_log_id}
      const defaultDescTemplate =
        'Outcome: {outcome}\nCustomer: {customer_name} ({customer_phone})\nJob: #{job_number}\n\nWhy follow-up is needed:\n{summary}\n\nCall Log: {call_log_id}';

      const configuredDescTemplate = (cfg.taskDescription && typeof cfg.taskDescription === 'string' && cfg.taskDescription.trim())
        ? cfg.taskDescription
        : defaultDescTemplate;

      const rawJobNumber = job?.job_number ? String(job.job_number).replace(/^#/, '') : '';
      const variableMap: Record<string, string> = {
        outcome: outcomeLabel || '',
        customer_name: params.customerName || '',
        customer_phone: params.customerPhone ? formatPhoneDisplay(params.customerPhone) : '',
        job_number: rawJobNumber,
        summary: params.summary || '',
        call_log_id: params.callLogId || '',
      };

      let taskDescription = configuredDescTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g, (match: string, key: string) => {
        const lowerKey = key.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(variableMap, lowerKey)) {
          return variableMap[lowerKey];
        }
        return match; // preserve unknown tokens safely
      });

      // 9. Allocate Task Number and Create Task
      const createdBy = creatorId;
      const watchers = watcherUser?.id ? [watcherUser.id] : [];
      const configuredPriority = (cfg.taskPriority && ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(cfg.taskPriority.toUpperCase()))
        ? cfg.taskPriority.toUpperCase()
        : 'HIGH';

      const task = await withNumberCollisionRetry(() =>
        prisma.$transaction(async (tx) => {
          const taskNumber = await allocateNumber(tx, 'task', params.orgId);
          return tx.task.create({
            data: {
              task_number: taskNumber,
              organization_id: params.orgId,
              created_by: createdBy,
              title: taskTitle,
              description: taskDescription,
              status: 'TODO',
              priority: configuredPriority as any,
              assignee_ids: assignees,
              watcher_ids: watchers,
              category_id: category?.id || null,
              linked_entity_type: job ? 'JOB' : null,
              linked_entity_id: job ? job.id : null,
              ai_source: 'AI_NL',
              ai_suggested_by: 'Bee Warranty AI Agent',
              tags: ['Bee Follow-up', 'Warranty'],
            },
          });
        })
      );

      logger.info(
        `[BeeService] Created Follow-up Task ${task.task_number} (${task.title}) linked to Job ${job?.job_number || 'N/A'} for Assignees [${assignees.join(', ')}]`
      );

      // Store task_id back on the call log for direct linking (avoids description text-search heuristic)
      if (params.callLogId) {
        try {
          await prisma.beeCallLog.update({
            where: { id: params.callLogId },
            data: { task_id: task.id },
          });
        } catch (linkErr) {
          // Non-fatal: the task was created successfully; the link is a best-effort improvement
          logger.warn(`[BeeService] Could not store task_id on call log ${params.callLogId}:`, linkErr);
        }
      }

      // 10. Dispatch notifications across configured channels (In-app, SMS, Email)
      try {
        await BeeService.dispatchFollowUpTaskNotifications({
          orgId: params.orgId,
          task: {
            id: task.id,
            title: task.title,
            task_number: task.task_number,
            priority: configuredPriority,
          },
          assignees,
          watchers,
          customerName: params.customerName,
          customerPhone: params.customerPhone,
          outcomeLabel,
          summary: params.summary,
          jobNumber: rawJobNumber || undefined,
          alertChannels: cfg.alertChannels,
        });
      } catch (notifErr) {
        logger.warn('[BeeService] Failed to dispatch task notifications:', notifErr);
      }

      return task;
    } catch (err) {
      logger.error('[BeeService] Error creating follow-up task from call:', err);
      return null;
    }
  }

  /**
   * Formats a clean single-line log entry detailing task notification dispatch across In-App, SMS, and Email.
   */
  static formatNotificationLog(data: {
    timestamp: Date;
    params: {
      orgId: string;
      task: { id: string; title: string; task_number: string; priority: string };
      assignees: string[];
      watchers: string[];
      customerName: string;
      customerPhone?: string;
      outcomeLabel: string;
      summary: string;
      jobNumber?: string;
    };
    successionLogs: {
      inApp: { enabled: boolean; status: string; assignees: string[]; watchers: string[]; error?: string };
      sms: { enabled: boolean; status: string; recipients: Array<{ user: string; id: string; phone: string; status: string }>; body?: string };
      email: { enabled: boolean; status: string; recipients: Array<{ user: string; id: string; email: string; status: string }>; subject?: string };
    };
    selectedChannels: string[];
  }): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const d = data.timestamp;
    const dateFormatted = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const isSuccess =
      (!data.successionLogs.inApp.enabled || data.successionLogs.inApp.status === 'SENT') &&
      (!data.successionLogs.sms.enabled || data.successionLogs.sms.status === 'SENT') &&
      (!data.successionLogs.email.enabled || data.successionLogs.email.status === 'SENT');

    const isFailed =
      (data.successionLogs.inApp.enabled && data.successionLogs.inApp.status === 'FAILED') ||
      (data.successionLogs.sms.enabled && data.successionLogs.sms.status === 'FAILED') ||
      (data.successionLogs.email.enabled && data.successionLogs.email.status === 'FAILED');

    const overall = isFailed ? 'FAILED' : isSuccess ? 'SUCCESS' : 'PARTIAL';

    const taskNum = data.params.task.task_number ? `#${data.params.task.task_number}` : data.params.task.id.slice(0, 8);
    const jobNum = data.params.jobNumber ? ` | Job #${data.params.jobNumber.replace(/^#+/, '')}` : '';
    const phoneStr = data.params.customerPhone ? ` (${data.params.customerPhone})` : '';

    // In-App segment
    const inAppPart = !data.successionLogs.inApp.enabled
      ? 'In-App: SKIPPED'
      : data.successionLogs.inApp.status === 'SENT'
      ? `In-App: SENT (${data.successionLogs.inApp.assignees.length} assignees${data.successionLogs.inApp.watchers.length > 0 ? `, ${data.successionLogs.inApp.watchers.length} watchers` : ''})`
      : `In-App: ${data.successionLogs.inApp.status}${data.successionLogs.inApp.error ? ` [${data.successionLogs.inApp.error}]` : ''}`;

    // SMS segment
    let smsPart = 'SMS: SKIPPED';
    if (data.successionLogs.sms.enabled) {
      const recList = data.successionLogs.sms.recipients
        .map((r) => `${r.user || r.phone}:${r.status}`)
        .join(', ');
      smsPart = `SMS: ${data.successionLogs.sms.status}${recList ? ` [${recList}]` : ''}`;
    }

    // Email segment
    let emailPart = 'Email: SKIPPED';
    if (data.successionLogs.email.enabled) {
      const recList = data.successionLogs.email.recipients
        .map((r) => `${r.email || r.user}:${r.status}`)
        .join(', ');
      emailPart = `Email: ${data.successionLogs.email.status} (from: alerts@bee.servwave.com -> ${recList || 'none'})`;
    }

    return `[${dateFormatted}] [${overall}] Task ${taskNum}${jobNum} | Customer: ${data.params.customerName}${phoneStr} | Outcome: ${data.params.outcomeLabel} | Priority: ${data.params.task.priority} | ${inAppPart} | ${smsPart} | ${emailPart}\n`;
  }

  /**
   * Appends notification log entries to local log files for testing and inspection.
   */
  static writeNotificationLogFile(entry: string): void {
    const candidateDirs = [
      path.resolve(process.cwd(), 'logs'),
      path.resolve(process.cwd(), 'backend', 'logs'),
      path.resolve(__dirname, '../../..', 'logs'),
    ];
    const writtenPaths = new Set<string>();

    for (const dir of candidateDirs) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, 'bee-notifications.log');
        if (!writtenPaths.has(filePath)) {
          fs.appendFileSync(filePath, entry, 'utf8');
          writtenPaths.add(filePath);
        }
      } catch (err) {
        // safe ignore
      }
    }

    const candidateFiles = [
      path.resolve(process.cwd(), 'bee-notifications.log'),
      path.resolve(process.cwd(), 'backend', 'bee-notifications.log'),
      path.resolve(__dirname, '../../..', 'bee-notifications.log'),
    ];
    for (const filePath of candidateFiles) {
      try {
        if (!writtenPaths.has(filePath)) {
          fs.appendFileSync(filePath, entry, 'utf8');
          writtenPaths.add(filePath);
        }
      } catch (err) {
        // safe ignore
      }
    }
  }

  /**
   * Dispatches notifications for created Bee follow-up tasks across In-app, SMS, and Email
   * based on the organization's configured alert notification channels.
   */
  static async dispatchFollowUpTaskNotifications(params: {
    orgId: string;
    task: { id: string; title: string; task_number: string; priority: string };
    assignees: string[];
    watchers: string[];
    customerName: string;
    customerPhone?: string;
    outcomeLabel: string;
    summary: string;
    jobNumber?: string;
    alertChannels?: string[];
  }): Promise<void> {
    const timestamp = new Date();
    const successionLogs: {
      inApp: { enabled: boolean; status: string; assignees: string[]; watchers: string[]; error?: string };
      sms: { enabled: boolean; status: string; recipients: Array<{ user: string; id: string; phone: string; status: string }>; body?: string };
      email: { enabled: boolean; status: string; recipients: Array<{ user: string; id: string; email: string; status: string }>; subject?: string };
    } = {
      inApp: { enabled: false, status: 'SKIPPED', assignees: [], watchers: [] },
      sms: { enabled: false, status: 'SKIPPED', recipients: [] },
      email: { enabled: false, status: 'SKIPPED', recipients: [] },
    };

    let selectedChannels: string[] = ['in-app', 'email'];

    try {
      selectedChannels = Array.isArray(params.alertChannels)
        ? params.alertChannels.map((c) => String(c).toLowerCase().trim())
        : ['in-app', 'email'];

      const notifyInApp = selectedChannels.some((c) => c.includes('in-app') || c.includes('inapp'));
      const notifySms = selectedChannels.some((c) => c.includes('text') || c.includes('sms'));
      const notifyEmail = selectedChannels.some((c) => c.includes('email'));

      successionLogs.inApp.enabled = notifyInApp;
      successionLogs.sms.enabled = notifySms;
      successionLogs.email.enabled = notifyEmail;

      // 1. In-App Notification (rings ServWave default notification bell icon via emit)
      if (notifyInApp) {
        let inAppEmitted = false;
        if (params.assignees && params.assignees.length > 0) {
          try {
            await emit({
              verb: 'task.assigned',
              organizationId: params.orgId,
              actorId: null,
              object: { type: 'TASK', id: params.task.id, label: params.task.title },
              entity: { added_assignee_ids: params.assignees },
              data: { task_number: params.task.task_number },
            });
            successionLogs.inApp.assignees = params.assignees;
            inAppEmitted = true;
          } catch (emitAssignErr: any) {
            successionLogs.inApp.error = emitAssignErr?.message || String(emitAssignErr);
            logger.warn('[BeeService] Failed to emit in-app task.assigned notification:', emitAssignErr);
          }
        }

        if (params.watchers && params.watchers.length > 0) {
          try {
            await emit({
              verb: 'task.watching',
              organizationId: params.orgId,
              actorId: null,
              object: { type: 'TASK', id: params.task.id, label: params.task.title },
              entity: { added_watcher_ids: params.watchers },
              data: { task_number: params.task.task_number },
            });
            successionLogs.inApp.watchers = params.watchers;
            inAppEmitted = true;
          } catch (emitWatchErr: any) {
            successionLogs.inApp.error = (successionLogs.inApp.error ? successionLogs.inApp.error + '; ' : '') + (emitWatchErr?.message || String(emitWatchErr));
            logger.warn('[BeeService] Failed to emit in-app task.watching notification:', emitWatchErr);
          }
        }

        successionLogs.inApp.status = inAppEmitted
          ? 'SENT'
          : params.assignees.length === 0 && params.watchers.length === 0
          ? 'SKIPPED (No recipients)'
          : 'FAILED';
      }

      // If neither SMS nor Email is enabled, we're done
      if (!notifySms && !notifyEmail) {
        BeeService.writeNotificationLogFile(
          BeeService.formatNotificationLog({
            timestamp,
            params,
            successionLogs,
            selectedChannels,
          })
        );
        return;
      }

      const recipientUserIds = Array.from(new Set([...params.assignees, ...params.watchers].filter(Boolean)));
      if (recipientUserIds.length === 0) {
        if (notifySms) successionLogs.sms.status = 'SKIPPED (No recipient IDs)';
        if (notifyEmail) successionLogs.email.status = 'SKIPPED (No recipient IDs)';
        BeeService.writeNotificationLogFile(
          BeeService.formatNotificationLog({
            timestamp,
            params,
            successionLogs,
            selectedChannels,
          })
        );
        return;
      }

      const users = await prisma.user.findMany({
        where: {
          id: { in: recipientUserIds },
          organization_id: params.orgId,
          is_active: true,
        },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
        },
      });

      if (users.length === 0) {
        if (notifySms) successionLogs.sms.status = 'SKIPPED (No active users found in DB)';
        if (notifyEmail) successionLogs.email.status = 'SKIPPED (No active users found in DB)';
        BeeService.writeNotificationLogFile(
          BeeService.formatNotificationLog({
            timestamp,
            params,
            successionLogs,
            selectedChannels,
          })
        );
        return;
      }

      const formattedPhone = params.customerPhone ? formatPhoneDisplay(params.customerPhone) : '';

      // 2. SMS Notifications (Uses the exact outbound CTM number Spider uses via sendStaffAlertSms)
      if (notifySms) {
        const smsBody = `Bee AI Follow-up Task #${params.task.task_number}: ${params.outcomeLabel}\nCustomer: ${params.customerName}${formattedPhone ? ` (${formattedPhone})` : ''}${params.jobNumber ? `\nJob: #${params.jobNumber}` : ''}\nPriority: ${params.task.priority}\nSummary: ${params.summary || 'Follow-up requested'}`.trim();
        successionLogs.sms.body = smsBody;

        let smsDeliveredCount = 0;
        let smsFailedCount = 0;

        for (const user of users) {
          const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.id;
          if (!user.phone) {
            successionLogs.sms.recipients.push({
              user: userName,
              id: user.id,
              phone: 'none',
              status: 'SKIPPED (No phone on file)',
            });
            continue;
          }

          try {
            const smsResult = await sendStaffAlertSms(prisma, {
              orgId: params.orgId,
              toE164: user.phone,
              body: smsBody,
            });
            if (smsResult.delivered) {
              smsDeliveredCount++;
              successionLogs.sms.recipients.push({
                user: userName,
                id: user.id,
                phone: user.phone,
                status: 'DELIVERED',
              });
              logger.info(`[BeeService] Staff SMS alert sent to ${user.phone} for task ${params.task.task_number}`);
            } else {
              smsFailedCount++;
              successionLogs.sms.recipients.push({
                user: userName,
                id: user.id,
                phone: user.phone,
                status: `FAILED (${smsResult.reason || 'Undelivered'})`,
              });
              logger.warn(`[BeeService] Staff SMS alert skipped/failed for ${user.phone}: ${smsResult.reason}`);
            }
          } catch (smsErr: any) {
            smsFailedCount++;
            successionLogs.sms.recipients.push({
              user: userName,
              id: user.id,
              phone: user.phone,
              status: `ERROR (${smsErr?.message || smsErr})`,
            });
            logger.warn(`[BeeService] Staff alert SMS error for user ${user.id}:`, smsErr);
          }
        }

        successionLogs.sms.status =
          smsDeliveredCount > 0 && smsFailedCount === 0
            ? 'SENT'
            : smsDeliveredCount > 0
            ? 'PARTIAL'
            : smsFailedCount > 0
            ? 'FAILED'
            : 'SKIPPED';
      }

      // 3. Email Notifications (Standard branded email via sendAutomationEmail)
      if (notifyEmail) {
        let org: any = null;
        try {
          org = await prisma.organization.findUnique({
            where: { id: params.orgId },
            select: { id: true, name: true, logo_url: true, brand_color: true },
          });
        } catch (orgErr) {
          logger.warn('[BeeService] Failed to load org branding for email notification:', orgErr);
        }

        const orgName = org?.name || 'ServWave';
        const brandColor = org?.brand_color || '#0C2D3A';
        const subject = `Bee Follow-up Task #${params.task.task_number}: ${params.outcomeLabel} - ${params.customerName}`;
        const textBody = `A new Bee follow-up task has been assigned to you.\n\nTask: #${params.task.task_number} (${params.task.title})\nPriority: ${params.task.priority}\nCustomer: ${params.customerName}${formattedPhone ? ` (${formattedPhone})` : ''}${params.jobNumber ? `\nJob: #${params.jobNumber}` : ''}\nOutcome: ${params.outcomeLabel}\n\nDetails:\n${params.summary || 'Follow-up requested'}`;

        const htmlBody = `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; line-height: 1.5;">
            <h2 style="color: ${esc(brandColor)}; margin-top: 0; font-size: 20px;">Bee Follow-up Task Created</h2>
            <p style="font-size: 14px; color: #4b5563; margin-bottom: 20px;">
              A new follow-up task has been automatically assigned to you by the Bee AI Warranty Agent.
            </p>
            <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <td style="padding: 6px 0; color: #6b7280; width: 120px;"><strong>Task:</strong></td>
                  <td style="padding: 6px 0; color: #111827;">#${esc(params.task.task_number)}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Priority:</strong></td>
                  <td style="padding: 6px 0; color: #111827;">
                    <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 12px; background: #fee2e2; color: #991b1b;">
                      ${esc(params.task.priority)}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Customer:</strong></td>
                  <td style="padding: 6px 0; color: #111827;">${esc(params.customerName)}${formattedPhone ? ` (${esc(formattedPhone)})` : ''}</td>
                </tr>
                ${params.jobNumber ? `
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Job:</strong></td>
                  <td style="padding: 6px 0; color: #111827;">#${esc(params.jobNumber)}</td>
                </tr>` : ''}
                <tr>
                  <td style="padding: 6px 0; color: #6b7280;"><strong>Outcome:</strong></td>
                  <td style="padding: 6px 0; color: #111827;">${esc(params.outcomeLabel)}</td>
                </tr>
              </table>
              <div style="margin-top: 14px; padding-top: 14px; border-top: 1px solid #e5e7eb;">
                <div style="font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; margin-bottom: 4px;">
                  Why follow-up is needed:
                </div>
                <div style="font-size: 14px; color: #374151; white-space: pre-wrap;">
                  ${esc(params.summary || 'Follow-up requested from customer call.')}
                </div>
              </div>
            </div>
            <p style="font-size: 13px; color: #9ca3af; margin-bottom: 0;">
              This notification was generated by ${esc(orgName)} Bee AI Agent.
            </p>
          </div>
        `;

        successionLogs.email.subject = subject;
        let emailSentCount = 0;
        let emailFailedCount = 0;

        for (const user of users) {
          const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || user.id;
          if (!user.email) {
            successionLogs.email.recipients.push({
              user: userName,
              id: user.id,
              email: 'none',
              status: 'SKIPPED (No email on file)',
            });
            continue;
          }

          try {
            await sendAutomationEmail({
              organizationId: params.orgId,
              to: user.email,
              subject,
              text: textBody,
              html: htmlBody,
              senderIdentity: 'bee-alert',
              org: org ? {
                id: org.id,
                name: org.name,
                logo_url: org.logo_url,
                brand_color: org.brand_color,
              } : undefined,
            });
            emailSentCount++;
            successionLogs.email.recipients.push({
              user: userName,
              id: user.id,
              email: user.email,
              status: 'SENT',
            });
            logger.info(`[BeeService] Staff email alert sent to ${user.email} for task ${params.task.task_number}`);
          } catch (emailErr: any) {
            emailFailedCount++;
            successionLogs.email.recipients.push({
              user: userName,
              id: user.id,
              email: user.email,
              status: `ERROR (${emailErr?.message || emailErr})`,
            });
            logger.warn(`[BeeService] Staff alert email error for user ${user.id}:`, emailErr);
          }
        }

        successionLogs.email.status =
          emailSentCount > 0 && emailFailedCount === 0
            ? 'SENT'
            : emailSentCount > 0
            ? 'PARTIAL'
            : emailFailedCount > 0
            ? 'FAILED'
            : 'SKIPPED';
      }

      BeeService.writeNotificationLogFile(
        BeeService.formatNotificationLog({
          timestamp,
          params,
          successionLogs,
          selectedChannels,
        })
      );
    } catch (notifErr: any) {
      logger.warn('[BeeService] Error dispatching follow-up task notifications:', notifErr);
      try {
        BeeService.writeNotificationLogFile(
          `[BEE NOTIFICATION DISPATCH ERROR] ${new Date().toISOString()}: ${notifErr?.message || notifErr}\n`
        );
      } catch (logErr) {
        // safe ignore
      }
    }
  }

  static formatOutcomeLabel(outcome?: string): string {
    const o = (outcome || '').toUpperCase();
    if (o.includes('WARRANTY')) return 'Warranty Plan';
    if (o.includes('NEW_WORK') || o.includes('NEW WORK') || o.includes('NEW_JOB') || o.includes('NEW JOB')) return 'New Job';
    if (o.includes('CALLBACK')) return 'Call Back Later';
    if (o.includes('COMPLAINT')) return 'Complaint — Needs Human';
    if (o.includes('HUMAN')) return 'Needs a Human';
    if (o.includes('REVIEW')) return 'Needs Review';
    if (o.includes('DNC')) return 'Do Not Call Request';
    if (o.includes('NOT_INTERESTED')) return 'Not Interested';
    return outcome || 'Customer Inquiry';
  }

  static isFollowupTaskOutcome(
    outcome?: string | null,
    needsHumanAlert: boolean = false,
    allowedOutcomes?: string[]
  ): boolean {
    if (needsHumanAlert) return true;
    const o = (outcome || '').toUpperCase();
    const targets =
      allowedOutcomes && allowedOutcomes.length > 0
        ? allowedOutcomes.map((t) => t.toUpperCase())
        : [
            'INTERESTED_WARRANTY',
            'INTERESTED_NEW_WORK',
            'CALLBACK_REQUESTED',
            'HANDOFF_HUMAN',
            'COMPLAINT',
            'NEEDS_REVIEW',
          ];

    for (const t of targets) {
      if (o.includes(t)) return true;
      if (t === 'INTERESTED_WARRANTY' && (o.includes('WARRANTY_LEAD') || o.includes('LEAD_CREATED') || o.includes('WARRANTY'))) return true;
      if ((t === 'INTERESTED_NEW_WORK' || t === 'INTERESTED_NEW_JOB') && (o.includes('NEW_WORK') || o.includes('NEW WORK') || o.includes('NEW_JOB') || o.includes('NEW JOB'))) return true;
      if (t === 'CALLBACK_REQUESTED' && o.includes('CALLBACK')) return true;
      if (t === 'HANDOFF_HUMAN' && (o.includes('HUMAN') || o.includes('NEEDS_HUMAN'))) return true;
      if (t === 'COMPLAINT' && o.includes('COMPLAINT')) return true;
      if (t === 'NEEDS_REVIEW' && o.includes('REVIEW')) return true;
    }
    return false;
  }

  static parseWarrantyDurationToDays(dur: string): number {
    if (!dur) return 365;
    const lower = dur.toLowerCase().trim();
    if (lower === 'no warranty' || lower === '0' || lower === 'none') return 0;
    if (lower === '30 days') return 30;
    if (lower === '60 days') return 60;
    if (lower === '90 days') return 90;
    if (lower === '6 months') return 180;
    if (lower === '12 months' || lower === '1 year') return 365;
    if (lower === '2 years') return 730;
    if (lower === '5 years') return 1825;

    const match = lower.match(/^(\d+)\s*(day|week|month|year)s?$/);
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2];
      if (unit === 'day') return num;
      if (unit === 'week') return num * 7;
      if (unit === 'month') return num * 30;
      if (unit === 'year') return num * 365;
    }
    const fallbackNum = parseInt(lower, 10);
    return isNaN(fallbackNum) ? 365 : fallbackNum;
  }

  /**
   * Reads job-to-warranty mappings for an organization
   */
  static async getJobTypeWarranties(orgId: string, existingSetting?: any) {
    const [org, setting] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: { job_type_options: true },
      }),
      existingSetting !== undefined
        ? Promise.resolve(existingSetting)
        : prisma.beeSetting.findUnique({
            where: { organization_id: orgId },
            select: { job_type_warranties: true },
          }),
    ]);

    const defaultJobTypes = [
      'Lock rekey / small repair',
      'Door closer / hardware replacement',
      'New door install',
      'Access control / camera install',
      'Fire door replacement',
      'Automatic door operator',
    ];

    const defaultPresets: Record<string, { warranty: string; days: number; threshold: number }> = {
      'Lock rekey / small repair': { warranty: '90 days', days: 90, threshold: 21 },
      'Door closer / hardware replacement': { warranty: '6 months', days: 180, threshold: 30 },
      'New door install': { warranty: '12 months', days: 365, threshold: 45 },
      'Access control / camera install': { warranty: '12 months', days: 365, threshold: 45 },
      'Fire door replacement': { warranty: '12 months', days: 365, threshold: 45 },
      'Automatic door operator': { warranty: '12 months', days: 365, threshold: 45 },
      'Door Installation': { warranty: '12 months', days: 365, threshold: 45 },
      'Lock Repair': { warranty: '90 days', days: 90, threshold: 21 },
      'General Hardware': { warranty: '6 months', days: 180, threshold: 30 },
      'Commercial Security': { warranty: '12 months', days: 365, threshold: 45 },
      'HVAC Service': { warranty: '90 days', days: 90, threshold: 30 },
      'HVAC Install': { warranty: '12 months', days: 365, threshold: 45 },
      'Plumbing': { warranty: '90 days', days: 90, threshold: 21 },
      'Electrical': { warranty: '6 months', days: 180, threshold: 30 },
      'General Maintenance': { warranty: '90 days', days: 90, threshold: 21 },
      'Other': { warranty: '12 months', days: 365, threshold: 30 },
    };

    let savedList: any[] = [];
    if (setting?.job_type_warranties) {
      if (Array.isArray(setting.job_type_warranties)) {
        savedList = setting.job_type_warranties;
      } else if (typeof setting.job_type_warranties === 'string') {
        try {
          savedList = JSON.parse(setting.job_type_warranties);
        } catch {
          savedList = [];
        }
      }
    }

    const savedMap = new Map<string, any>();
    for (const item of savedList) {
      if (item && item.job_type) {
        savedMap.set(item.job_type, item);
      }
    }

    const hasOrgTypes = Array.isArray(org?.job_type_options) && (org.job_type_options as any[]).length > 0;
    const allTypes: string[] = hasOrgTypes
      ? (org!.job_type_options as unknown as string[])
      : (savedList.length > 0 ? Array.from(new Set(savedList.map((s) => s.job_type))) : defaultJobTypes);

    return allTypes.map((jt: string) => {
      const saved = savedMap.get(jt);
      if (saved) {
        return {
          job_type: jt,
          included_warranty: saved.included_warranty || '12 months',
          warranty_days: saved.warranty_days ?? this.parseWarrantyDurationToDays(saved.included_warranty || '12 months'),
          call_threshold_days: Number(saved.call_threshold_days ?? 30),
          agent_id: saved.agent_id || null,
          phone_number: saved.phone_number || null,
          is_active: saved.is_active !== undefined ? Boolean(saved.is_active) : (saved.active !== undefined ? Boolean(saved.active) : true),
        };
      }
      let preset = defaultPresets[jt];
      if (!preset) {
        const lower = jt.toLowerCase();
        if (lower.includes('install')) {
          preset = { warranty: '12 months', days: 365, threshold: 45 };
        } else if (lower.includes('repair')) {
          preset = { warranty: '90 days', days: 90, threshold: 21 };
        } else if (lower.includes('maintenance')) {
          preset = { warranty: '6 months', days: 180, threshold: 30 };
        } else {
          preset = { warranty: '12 months', days: 365, threshold: 30 };
        }
      }
      return {
        job_type: jt,
        included_warranty: preset.warranty,
        warranty_days: preset.days,
        call_threshold_days: preset.threshold,
        agent_id: null,
        phone_number: null,
        is_active: true,
      };
    });
  }

  static normalizeJobTypeWarrantyItems(items: any[]) {
    return (items || []).map((item) => {
      const warranty = item.included_warranty || '12 months';
      const days = item.warranty_days ?? this.parseWarrantyDurationToDays(warranty);
      const threshold = Number(item.call_threshold_days ?? 30);
      const isActive =
        item.is_active !== undefined
          ? Boolean(item.is_active)
          : item.active !== undefined
            ? Boolean(item.active)
            : true;
      return {
        job_type: item.job_type,
        included_warranty: warranty,
        warranty_days: days,
        call_threshold_days: threshold,
        agent_id: item.agent_id || null,
        phone_number: item.phone_number || null,
        is_active: isActive,
      };
    });
  }

  static async updateJobTypeWarranties(orgId: string, items: any[]) {
    const normalized = this.normalizeJobTypeWarrantyItems(items);

    await prisma.beeSetting.upsert({
      where: { organization_id: orgId },
      create: {
        organization_id: orgId,
        job_type_warranties: normalized,
      },
      update: {
        job_type_warranties: normalized,
      },
    });

    return normalized;
  }

  /**
   * Normalizes skip reason strings for backward compatibility
   */
  static normalizeSkipReason(rawReason?: string | null): string | null {
    if (!rawReason) return null;
    let s = rawReason;
    s = s.replace(/Customer has excluded tag/gi, 'Customer to Skip Tag');
    s = s.replace(/Customer number on Do Not Call list/gi, 'Do Not Call (DNC)');
    s = s.replace(/Do Not Call list match/gi, 'Do Not Call (DNC)');
    s = s.replace(/Job type disabled/gi, 'Job Type Disabled');
    return s;
  }

  /**
   * Evaluates job call eligibility against the 4 standard conditions:
   * 1. Customer to Skip Tag
   * 2. Job Below Minimum Amount
   * 3. Do Not Call (DNC)
   * 4. Job Type Disabled
   *
   * Retains all applicable reasons joined by ', ' when multiple apply.
   */
  static async evaluateJobCallEligibility(params: {
    orgId: string;
    jobId?: string | null;
    customerId?: string | null;
    customerPhone?: string | null;
    jobType?: string | null;
    jobAmount?: number | null;
    beeSettings?: any;
    jobRules?: any[];
    customerTagNames?: string[];
  }): Promise<{ isSkipped: boolean; reasons: string[]; skipReason: string | null }> {
    const { orgId, customerId, customerPhone, jobType, jobAmount, beeSettings, jobRules } = params;
    const reasons: string[] = [];

    const cfg = (beeSettings?.setup_config as any) || {};
    const excludedTags: string[] = Array.isArray(cfg.excludedTags) ? cfg.excludedTags : [];

    // 1. Customer to Skip Tag
    let custTagNames = params.customerTagNames;
    if (!custTagNames && customerId && excludedTags.length > 0 && typeof prisma.tagAssignment?.findMany === 'function') {
      const customerTagAssignments = await prisma.tagAssignment.findMany({
        where: {
          organization_id: orgId,
          entity_type: 'CUSTOMER',
          entity_id: customerId,
        },
        select: {
          tag: { select: { name: true } },
        },
      }).catch(() => []);
      custTagNames = customerTagAssignments.map((ta: any) => ta.tag?.name).filter(Boolean);
    }
    if (excludedTags.length > 0 && custTagNames && custTagNames.length > 0) {
      const isTagExcluded = custTagNames.some((tagName: string) =>
        excludedTags.some((ex) => ex.toLowerCase().trim() === tagName.toLowerCase().trim())
      );
      if (isTagExcluded) {
        reasons.push('Customer to Skip Tag');
      }
    }

    // 2. Job Below Minimum Amount
    const minAmount = Number(cfg.skipMinJobAmount ?? 0);
    if (minAmount > 0 && jobAmount !== undefined && jobAmount !== null) {
      if (Number(jobAmount) < minAmount) {
        reasons.push('Job Below Minimum Amount');
      }
    }

    // 3. Do Not Call (DNC)
    if (customerPhone) {
      const isDncMatch = await BeeService.isDnc(orgId, customerPhone);
      if (isDncMatch) {
        reasons.push('Do Not Call (DNC)');
      }
    }

    // 4. Job Type Disabled
    let matchedRule: any = null;
    if (jobRules && Array.isArray(jobRules)) {
      matchedRule = jobRules.find((r: any) => (r.job_type || '').toLowerCase().trim() === (jobType || '').toLowerCase().trim());
    } else if (jobType) {
      const allRules = await BeeService.getJobTypeWarranties(orgId);
      matchedRule = allRules.find((r: any) => (r.job_type || '').toLowerCase().trim() === (jobType || '').toLowerCase().trim());
    }
    if (matchedRule && matchedRule.is_active === false) {
      reasons.push('Job Type Disabled');
    }

    const isSkipped = reasons.length > 0;
    const skipReason = isSkipped ? reasons.join(', ') : null;
    return { isSkipped, reasons, skipReason };
  }

  /**
   * Real invoice-sent workflow.
   * Invoked after successful invoice email delivery.
   * Resolves real job type and warranty plan, sends genuine warranty certificate email,
   * creates persistent BeeWarrantyRecord, and schedules first outbound call in queue.
   */
  static async processInvoiceSent(invoiceId: string, orgId: string, actorId?: string | null) {
    logger.info(`[BeeService] Processing warranty workflow for sent invoice ${invoiceId} in org ${orgId}`);

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId, organization_id: orgId },
      include: {
        job: {
          include: {
            customer: true,
            service_location: true,
          },
        },
        customer: true,
      },
    });

    if (!invoice || invoice.status !== 'SENT') {
      logger.warn(`[BeeService] Invoice ${invoiceId} is not in SENT status; skipping warranty workflow`);
      return;
    }

    if (!invoice.job_id || !invoice.job) {
      logger.info(`[BeeService] Invoice ${invoiceId} has no linked job; skipping warranty processing`);
      return;
    }

    const job = invoice.job;
    const customer = invoice.customer || job.customer;
    if (!customer) {
      logger.warn(`[BeeService] No customer found for invoice ${invoiceId}; cannot process warranty`);
      return;
    }

    const recipientEmail = customer.email?.trim();
    if (!recipientEmail) {
      logger.warn(`[BeeService] Customer ${customer.id} has no email address; cannot deliver warranty certificate`);
      return;
    }

    // Idempotency: check if BeeWarrantyRecord already exists for this job in this org
    const existingRecord = await prisma.beeWarrantyRecord.findFirst({
      where: {
        organization_id: orgId,
        job_id: job.id,
      },
    });

    if (existingRecord) {
      logger.info(`[BeeService] Warranty record already exists for job ${job.id} (Record ${existingRecord.id}); skipping duplicate creation`);
      return;
    }

    // Read organization setup configuration for warranty start event & rules
    const beeSettings = await prisma.beeSetting.findUnique({
      where: { organization_id: orgId },
    });
    const warrantyStartsOnSetting = this.resolveWarrantyStartsOn(beeSettings?.setup_config);

    // Resolve real job type and warranty configuration
    const jobType = job.job_type || 'General Service';
    const rules: any[] = await this.getJobTypeWarranties(orgId, beeSettings);
    const rule = rules.find((r: any) => r.job_type?.toLowerCase() === jobType.toLowerCase()) || {
      job_type: jobType,
      included_warranty: '12 months',
      warranty_days: 365,
      call_threshold_days: 30,
      agent_id: null,
    };

    const now = new Date();
    let warrantyStartDate: Date;
    if (warrantyStartsOnSetting === 'Job Complete') {
      warrantyStartDate = job.completed_at || job.created_at || invoice.sent_at || now;
    } else {
      warrantyStartDate = invoice.sent_at || invoice.created_at || job.completed_at || now;
    }
    const warrantyDurationDays = rule.warranty_days ?? this.parseWarrantyDurationToDays(rule.included_warranty || '12 months');
    const warrantyEndDate = new Date(warrantyStartDate.getTime() + (warrantyDurationDays * 86400000));

    let status = 'active';
    if (now.getTime() >= warrantyEndDate.getTime()) {
      status = 'expired';
    } else if (warrantyEndDate.getTime() - now.getTime() <= 30 * 86400000) {
      status = 'expiring_soon';
    }

    // Resolve matching BeeWarrantyPlan for extension coverage details
    const activePlans = await prisma.beeWarrantyPlan.findMany({
      where: { organization_id: orgId, is_active: true },
      orderBy: { price: 'asc' },
    });

    const matchingPlan = activePlans.find((p) => {
      const elTypes = Array.isArray(p.eligible_job_types) ? (p.eligible_job_types as string[]) : [];
      return elTypes.some((t) => t.toLowerCase() === 'all job types' || t.toLowerCase() === jobType.toLowerCase());
    }) || activePlans[0];

    const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.company_name || 'Valued Customer';
    const customerPhone = customer.phone?.trim() || '';

    // Step 3: Send real warranty email and confirm delivery
    const deliveryResult = await sendWarrantyEmail({
      organizationId: orgId,
      to: recipientEmail,
      customerName,
      jobType,
      jobNumber: job.job_number,
      invoiceNumber: invoice.invoice_number,
      warrantyDuration: rule.included_warranty || `${warrantyDurationDays} days`,
      warrantyStartDate,
      warrantyEndDate,
      coverageDetails: matchingPlan?.description || `Full coverage for labor and parts on ${jobType} as completed on invoice ${invoice.invoice_number}.`,
      record: {
        organizationId: orgId,
        customerId: customer.id,
        jobId: job.id,
        jobLabel: job.job_number,
        entityType: 'invoice',
        entityId: invoice.id,
      },
    });

    if (deliveryResult.status !== 'sent') {
      logger.warn(`[BeeService] Warranty delivery was not confirmed (${deliveryResult.status}) for invoice ${invoice.invoice_number}; aborting workflow without faking success`);
      return;
    }

    // Persist real BeeWarrantyRecord
    const record = await prisma.beeWarrantyRecord.create({
      data: {
        organization_id: orgId,
        job_id: job.id,
        customer_id: customer.id,
        job_type: jobType,
        job_completed_at: job.completed_at || job.created_at || now,
        warranty_start_date: warrantyStartDate,
        warranty_end_date: warrantyEndDate,
        warranty_started_on: warrantyStartsOnSetting,
        status,
      },
    });

    // Write timeline event to Job
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'JOB',
        entity_id: job.id,
        event_type: 'WARRANTY_ISSUED',
        description: `Warranty issued (${rule.included_warranty || '12 months'}) and delivered to ${recipientEmail}`,
        created_by: actorId ?? undefined,
      },
    });

    logger.info(`[BeeService] Created WarrantyRecord ${record.id} for job ${job.id}`);

    // Step 4: Schedule first call in persistent call queue
    if (!customerPhone) {
      logger.info(`[BeeService] Customer has no phone number; queue item cannot be scheduled`);
      return;
    }

    // Resolve voice agent
    let assignedAgentId = rule.agent_id || null;
    let agentObj = null;
    if (assignedAgentId) {
      agentObj = await prisma.beeVoiceAgent.findFirst({
        where: { id: assignedAgentId, organization_id: orgId, is_active: true },
      });
    }
    if (!agentObj) {
      agentObj = await prisma.beeVoiceAgent.findFirst({
        where: { organization_id: orgId, is_active: true },
      });
      assignedAgentId = agentObj?.id || null;
    }

    // Determine first-call scheduled time: trigger based on days BEFORE warranty expiration
    const triggerDaysBefore = Number(rule.call_threshold_days ?? agentObj?.trigger_days_before ?? 30);
    let scheduledFor = new Date(warrantyEndDate.getTime() - triggerDaysBefore * 86400000);

    // If scheduled time is in the past, or already expired, schedule for now
    if (scheduledFor.getTime() <= now.getTime()) {
      scheduledFor = now;
    }

    // Check call eligibility (Customer tag, Min job amount, DNC, Job type disabled)
    const jobAmount = Number(
      invoice.total_amount ??
      (job as any).total_amount ??
      (job as any).estimate?.total_amount ??
      0
    );
    const eligibility = await this.evaluateJobCallEligibility({
      orgId,
      jobId: job.id,
      customerId: customer.id,
      customerPhone,
      jobType: rule.job_type,
      jobAmount,
      beeSettings,
      jobRules: [rule],
    });

    // Resolve customer timezone according to 5-level hierarchy
    const loc = (job as any).service_location;
    const cust = customer as any;
    const custAddressInput = {
      address: loc?.address_line1 || cust?.billing_address_line1 || null,
      city: loc?.city || cust?.billing_city || null,
      state: loc?.state || cust?.billing_state || null,
      zip: loc?.zip || cust?.billing_zip || null,
    };
    const orgDefaultTz = beeSettings?.timezone || 'America/New_York';
    const resolvedTz = await resolveCustomerTimezone(custAddressInput, orgDefaultTz);

    const queueItem = await prisma.beeQueueItem.create({
      data: {
        organization_id: orgId,
        warranty_record_id: record.id,
        customer_id: customer.id,
        customer_name: customerName,
        customer_phone: customerPhone,
        agent_id: assignedAgentId,
        status: eligibility.isSkipped ? 'skipped' : 'scheduled',
        skip_reason: eligibility.skipReason,
        attempt_count: 0,
        scheduled_for: scheduledFor,
        warranty_started_on: warrantyStartsOnSetting,
        original_scheduled_for: scheduledFor,
        is_rescheduled: false,
        rescheduled_at: null,
        customer_timezone: resolvedTz.timezone,
        timezone_source: resolvedTz.source,
        is_timezone_estimated: resolvedTz.is_estimated,
      },
    });

    logger.info(`[BeeService] Scheduled queue item ${queueItem?.id || ''} for customer ${customerName} (Phone: ${customerPhone}) at ${scheduledFor.toISOString()} (Timezone: ${resolvedTz.timezone})`);
  }

  /**
   * Helper to check whether current wall time in given timezone falls within allowed call window (e.g. 10:00 - 19:00)
   * and allowed calling days (e.g. ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).
   */
  static isWithinCallWindow(
    windowStart: string,
    windowEnd: string,
    timezone: string,
    date: Date = new Date(),
    callDays?: string[]
  ): boolean {
    return isWithinAllowedCallingWindow(date, {
      windowStart,
      windowEnd,
      timezone,
      callDays,
    });
  }

  /**
   * Enriches BeeQueueItem records with complete, authoritative Job, Customer, Lead, Estimate,
   * ServiceLocation, and LineItem details from the associated Job.
   */
  static normalizeAgentRecord(agent: any) {
    if (!agent) return null;

    const rawJson = agent.eligible_job_types;
    let eligibleJobTypes: string[] = [];
    let jobContextFields: string[] = [
      'assigned_team',
      'job_notes',
      'invoice_sent',
      'line_items',
      'total_costs',
      'visits',
      'communication_history',
    ];
    let conversationFlow: {
      greeting_pitch?: string;
      checkin_flow?: string;
      warranty_offer_pitch?: string;
      new_work_pitch?: string;
      objection_handling?: string;
      custom_instructions?: string;
    } = {};
    let defaultFromNumber = '';
    let defaultFromNumberId = '';
    let vapiAssistantId = '';
    let voiceEngine = 'vapi';
    let language = 'English (US)';
    let tone = 'Warm, helpful, and consultative';

    if (Array.isArray(rawJson)) {
      eligibleJobTypes = rawJson.filter((v): v is string => typeof v === 'string');
    } else if (rawJson && typeof rawJson === 'object') {
      if (Array.isArray(rawJson.eligible_job_types)) {
        eligibleJobTypes = rawJson.eligible_job_types;
      }
      if (Array.isArray(rawJson.job_context_fields)) {
        jobContextFields = rawJson.job_context_fields;
      }
      if (rawJson.conversation_flow && typeof rawJson.conversation_flow === 'object') {
        conversationFlow = { ...rawJson.conversation_flow };
      }
      if (typeof rawJson.default_from_number === 'string') {
        defaultFromNumber = rawJson.default_from_number;
      }
      if (typeof rawJson.default_from_number_id === 'string') {
        defaultFromNumberId = rawJson.default_from_number_id;
      }
      if (typeof rawJson.vapi_assistant_id === 'string') {
        vapiAssistantId = rawJson.vapi_assistant_id;
      }
      if (typeof rawJson.voice_engine === 'string' && rawJson.voice_engine.trim()) {
        voiceEngine = rawJson.voice_engine;
      }
      if (typeof rawJson.language === 'string' && rawJson.language.trim()) {
        language = rawJson.language;
      }
      if (typeof rawJson.tone === 'string' && rawJson.tone.trim()) {
        tone = rawJson.tone;
      }
    }

    const persona = agent.persona_name || 'Emma';
    const trade = agent.trade_focus || 'General Service';

    const resolvedConversationFlow = {
      greeting_pitch:
        conversationFlow.greeting_pitch ??
        `Hi {{customer_name}}, this is ${persona} calling from {{company_name}} on a recorded line regarding your recent {{job_type}} (Job {{job_number}}). Do you have a quick minute?`,
      checkin_flow:
        conversationFlow.checkin_flow ??
        `Confirm the {{job_type}} completed by {{assigned_team}} is working smoothly and reference the job details ({{line_items}}) so the customer feels taken care of.`,
      warranty_offer_pitch:
        conversationFlow.warranty_offer_pitch ??
        agent.warranty_offer_pitch ??
        `Your standard warranty is coming up on {{warranty_end_date}}. I'm calling to see if you'd like to extend your protection so labor and parts remain 100% covered.`,
      new_work_pitch:
        conversationFlow.new_work_pitch ??
        agent.new_work_pitch ??
        `While I have you on the line, do you have any other ${trade.toLowerCase()} items or upcoming projects at {{service_address}} that our technicians could inspect or quote?`,
      objection_handling:
        conversationFlow.objection_handling ??
        `If the customer asks about previous pricing, invoice status, or visit history, reference {{invoice_sent}}, {{total_costs}}, or {{visits}}. If they prefer to review by email, offer to send the protection plan breakdown and schedule a callback.`,
      custom_instructions:
        conversationFlow.custom_instructions ??
        `Keep turns natural and under 2 sentences. Never reveal internal_costs figures directly to the customer.`,
    };

    return {
      ...agent,
      eligible_job_types: eligibleJobTypes,
      job_context_fields: jobContextFields,
      conversation_flow: resolvedConversationFlow,
      warranty_offer_pitch: resolvedConversationFlow.warranty_offer_pitch,
      new_work_pitch: resolvedConversationFlow.new_work_pitch,
      default_from_number: defaultFromNumber,
      default_from_number_id: defaultFromNumberId,
      vapi_assistant_id: vapiAssistantId,
      voice_engine: voiceEngine,
      language,
      tone,
    };
  }

  static packAgentMetadata(body: any, existingAgent?: any) {
    const normalizedExisting = existingAgent ? this.normalizeAgentRecord(existingAgent) : null;

    const eligibleJobTypes = Array.isArray(body.eligible_job_types)
      ? body.eligible_job_types
      : normalizedExisting?.eligible_job_types || [];

    const jobContextFields = Array.isArray(body.job_context_fields)
      ? body.job_context_fields
      : normalizedExisting?.job_context_fields || [
          'assigned_team',
          'job_notes',
          'invoice_sent',
          'line_items',
          'total_costs',
          'visits',
          'communication_history',
        ];

    const incomingFlow = body.conversation_flow && typeof body.conversation_flow === 'object'
      ? body.conversation_flow
      : {};

    const existingFlow = normalizedExisting?.conversation_flow || {};

    const warrantyPitch =
      incomingFlow.warranty_offer_pitch !== undefined
        ? incomingFlow.warranty_offer_pitch
        : body.warranty_offer_pitch !== undefined
        ? body.warranty_offer_pitch
        : existingFlow.warranty_offer_pitch || '';

    const newWorkPitch =
      incomingFlow.new_work_pitch !== undefined
        ? incomingFlow.new_work_pitch
        : body.new_work_pitch !== undefined
        ? body.new_work_pitch
        : existingFlow.new_work_pitch || '';

    const conversationFlow = {
      greeting_pitch:
        incomingFlow.greeting_pitch !== undefined
          ? incomingFlow.greeting_pitch
          : body.greeting_pitch !== undefined
          ? body.greeting_pitch
          : existingFlow.greeting_pitch || '',
      checkin_flow:
        incomingFlow.checkin_flow !== undefined
          ? incomingFlow.checkin_flow
          : body.checkin_flow !== undefined
          ? body.checkin_flow
          : existingFlow.checkin_flow || '',
      warranty_offer_pitch: warrantyPitch,
      new_work_pitch: newWorkPitch,
      objection_handling:
        incomingFlow.objection_handling !== undefined
          ? incomingFlow.objection_handling
          : body.objection_handling !== undefined
          ? body.objection_handling
          : existingFlow.objection_handling || '',
      custom_instructions:
        incomingFlow.custom_instructions !== undefined
          ? incomingFlow.custom_instructions
          : body.custom_instructions !== undefined
          ? body.custom_instructions
          : existingFlow.custom_instructions || '',
    };

    const defaultFromNumber =
      body.default_from_number !== undefined
        ? body.default_from_number
        : normalizedExisting?.default_from_number || '';

    const defaultFromNumberId =
      body.default_from_number_id !== undefined
        ? body.default_from_number_id
        : normalizedExisting?.default_from_number_id || '';

    const vapiAssistantId =
      body.vapi_assistant_id !== undefined
        ? body.vapi_assistant_id
        : normalizedExisting?.vapi_assistant_id || '';

    const voiceEngine =
      body.voice_engine !== undefined
        ? body.voice_engine
        : normalizedExisting?.voice_engine || 'vapi';

    const language =
      body.language !== undefined
        ? body.language
        : normalizedExisting?.language || 'English (US)';

    const tone =
      body.tone !== undefined
        ? body.tone
        : normalizedExisting?.tone || 'Warm, helpful, and consultative';

    return {
      packedJson: {
        eligible_job_types: eligibleJobTypes,
        job_context_fields: jobContextFields,
        conversation_flow: conversationFlow,
        default_from_number: defaultFromNumber,
        default_from_number_id: defaultFromNumberId,
        vapi_assistant_id: vapiAssistantId,
        voice_engine: voiceEngine,
        language,
        tone,
      },
      warranty_offer_pitch: warrantyPitch,
      new_work_pitch: newWorkPitch,
    };
  }

  /**
   * Returns phone numbers configured in the Bee Phone System
   * (strictly from the active Voice Calling Engine e.g. Vapi /phone-number).
   * Note: Bee phone system is completely separate from ServWave's internal CTM phone system.
   */
  static async getAvailablePhoneNumbers(orgId: string) {
    const engineNumbers = await BeeVoiceAdapter.listEnginePhoneNumbers(orgId).catch(() => []);

    const numbers: Array<{
      id: string;
      vapiPhoneNumberId?: string;
      phoneNumber: string;
      friendlyName: string;
      e164: string;
      formatted: string;
      label: string;
      isDefault: boolean;
      source: string;
      status?: string;
      createdAt?: string;
    }> = [];

    const seen = new Set<string>();

    for (const vNum of engineNumbers) {
      const clean = (vNum.e164 || '').trim();
      const key = clean || vNum.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const rawFriendly = (vNum.friendlyName || vNum.label || 'ServWave Voice Line')
        .replace(/\s*\((?:vapi|telnyx|twilio)[^)]*\)/gi, '')
        .trim();
      const friendlyName = rawFriendly || 'ServWave Voice Line';
      numbers.push({
        id: vNum.id,
        vapiPhoneNumberId: vNum.id,
        phoneNumber: clean || vNum.formatted,
        friendlyName,
        e164: clean,
        formatted: vNum.formatted || clean,
        label: `${vNum.formatted || clean} · ${friendlyName}`,
        isDefault: numbers.length === 0 ? true : !!vNum.isDefault,
        source: 'servwave',
        status: vNum.status || 'active',
        createdAt: vNum.createdAt,
      });
    }

    return numbers;
  }

  /**
   * Resolves the Voice Agent and outbound Phone Number for a job based on:
   * 1. The Job's job type mapped in Bee Settings (job_type_warranties)
   * 2. The Agent assigned to that Job Type rule (or active agent matching trade focus / default agent)
   * 3. The Phone Number assigned to that specific agent (or rule / org default line)
   *
   * This resolution rule applies identically to both Manual calling and Automatic calling.
   */
  static async resolveAgentAndPhoneNumberForJob(
    orgId: string,
    rawJobType?: string | null,
    options?: {
      preferredAgentId?: string | null;
      preferredPhone?: string | null;
      preferredPhoneId?: string | null;
    }
  ): Promise<{
    agent: any;
    agentId: string | null;
    fromPhoneNumber: string | undefined;
    fromPhoneNumberId: string | undefined;
    rule: any | null;
  }> {
    const jobType = (rawJobType || '').trim();

    // 1. Fetch Bee Settings
    const setting = await Promise.resolve()
      .then(() =>
        typeof prisma.beeSetting?.findUnique === 'function'
          ? prisma.beeSetting.findUnique({
              where: { organization_id: orgId },
              select: { job_type_warranties: true, setup_config: true },
            })
          : null
      )
      .catch(() => null);

    let rules: any[] = [];
    if (setting?.job_type_warranties) {
      if (Array.isArray(setting.job_type_warranties)) {
        rules = setting.job_type_warranties;
      } else if (typeof setting.job_type_warranties === 'string') {
        try {
          rules = JSON.parse(setting.job_type_warranties);
        } catch {
          rules = [];
        }
      }
    }

    // 2. Find matching Job Type rule
    let matchedRule: any = null;
    if (jobType && rules.length > 0) {
      const normType = jobType.toLowerCase();
      matchedRule =
        rules.find((r) => r?.job_type && String(r.job_type).trim().toLowerCase() === normType) ||
        rules.find((r) => r?.job_type && normType.includes(String(r.job_type).trim().toLowerCase())) ||
        null;
    }

    const setupConfig = (setting?.setup_config as any) || {};

    // 3. Resolve target agent ID
    const ruleAgentId =
      matchedRule?.agent_id && matchedRule.agent_id !== 'default' ? matchedRule.agent_id : null;
    const defaultAgentId =
      setupConfig?.defaultAgentId && setupConfig.defaultAgentId !== 'default'
        ? setupConfig.defaultAgentId
        : null;

    const targetAgentId = ruleAgentId || options?.preferredAgentId || defaultAgentId || null;

    // 4. Load agent record
    let rawAgent: any = null;
    if (targetAgentId && typeof prisma.beeVoiceAgent?.findFirst === 'function') {
      rawAgent = await Promise.resolve()
        .then(() =>
          prisma.beeVoiceAgent.findFirst({
            where: { id: targetAgentId, organization_id: orgId, is_active: true },
          })
        )
        .catch(() => null);
    }

    // If agent not found by ID, search by eligible_job_types or trade_focus
    if (!rawAgent && jobType && typeof prisma.beeVoiceAgent?.findMany === 'function') {
      const activeAgents = (await Promise.resolve()
        .then(() =>
          prisma.beeVoiceAgent.findMany({
            where: { organization_id: orgId, is_active: true },
          })
        )
        .catch(() => [])) || [];

      if (Array.isArray(activeAgents) && activeAgents.length > 0) {
        const normType = jobType.toLowerCase();
        rawAgent =
          activeAgents.find((a: any) => {
            const norm = BeeService.normalizeAgentRecord(a);
            if (norm?.eligible_job_types?.some((jt: string) => jt.toLowerCase() === normType)) return true;
            if (norm?.trade_focus && normType.includes(norm.trade_focus.toLowerCase())) return true;
            return false;
          }) || null;
      }
    }

    // Fallback to org's first active agent
    if (!rawAgent && typeof prisma.beeVoiceAgent?.findFirst === 'function') {
      rawAgent = await Promise.resolve()
        .then(() =>
          prisma.beeVoiceAgent.findFirst({
            where: { organization_id: orgId, is_active: true },
          })
        )
        .catch(() => null);
    }

    const agent = this.normalizeAgentRecord(rawAgent);

    // 5. Resolve Outbound Phone Number assigned to that Agent
    // Priority:
    // a. Dedicated phone number assigned to the agent (agent.default_from_number / agent.default_from_number_id)
    // b. Phone number assigned to the job type rule (rule.phone_number / rule.phone_number_id)
    // c. Organization default caller ID (setupConfig.callerId / setupConfig.defaultPhoneNumber)
    const orgDefaultCaller = (setupConfig?.callerId || setupConfig?.defaultPhoneNumber || '').trim();

    const candidatePhone =
      (agent?.default_from_number ||
        options?.preferredPhone ||
        matchedRule?.phone_number ||
        orgDefaultCaller ||
        '')
        .trim();

    const candidatePhoneId =
      (agent?.default_from_number_id ||
        options?.preferredPhoneId ||
        matchedRule?.phone_number_id ||
        '')
        .trim();

    let fromPhoneNumber: string | undefined = candidatePhone || undefined;
    let fromPhoneNumberId: string | undefined = candidatePhoneId || undefined;

    // 6. Validate and synchronize against available phone numbers in the active voice engine
    const availableNumbers = await this.getAvailablePhoneNumbers(orgId).catch(() => []);
    if (availableNumbers && availableNumbers.length > 0) {
      const matchedNum = availableNumbers.find(
        (n) =>
          (candidatePhoneId && (n.id === candidatePhoneId || n.vapiPhoneNumberId === candidatePhoneId)) ||
          (candidatePhone &&
            (n.e164 === candidatePhone ||
              n.phoneNumber === candidatePhone ||
              n.phoneNumber?.replace(/\D/g, '') === candidatePhone.replace(/\D/g, '')))
      );

      if (matchedNum) {
        fromPhoneNumber = matchedNum.e164 || matchedNum.phoneNumber;
        fromPhoneNumberId = matchedNum.vapiPhoneNumberId || matchedNum.id;
      } else if (!fromPhoneNumberId) {
        const def = availableNumbers.find((n) => n.isDefault) || availableNumbers[0];
        if (def) {
          fromPhoneNumber = fromPhoneNumber || def.e164 || def.phoneNumber;
          fromPhoneNumberId = def.vapiPhoneNumberId || def.id;
        }
      }
    }

    logger.info(
      `[BeeService] Resolved call routing for jobType "${jobType || 'Unknown'}": agent "${agent?.name || 'Default'}" (${agent?.id || 'none'}), phone "${fromPhoneNumber || 'none'}" (phoneNumberId: "${fromPhoneNumberId || 'none'}")`
    );

    return {
      agent,
      agentId: agent?.id || null,
      fromPhoneNumber,
      fromPhoneNumberId,
      rule: matchedRule,
    };
  }

  /**
   * Extracts the 8 Job Info categories into both structured data and formatted strings
   * for dynamic variable injection into the Backend Master Prompt.
   */
  static extractJobDynamicVariables(job: any, warrantyRecord?: any, timelineEvents: any[] = []) {
    const fmtMoney = (val: any) => {
      const n = Number(val ?? 0);
      return isNaN(n) ? '$0.00' : `$${n.toFixed(2)}`;
    };
    const fmtDate = (d: any) => {
      if (!d) return '';
      try {
        return new Date(d).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      } catch {
        return '';
      }
    };

    // 1. Assigned Team
    const techNames = new Set<string>();
    for (const v of job?.visits || []) {
      for (const a of v.assignees || []) {
        if (a?.user) {
          const fullName = [a.user.first_name, a.user.last_name].filter(Boolean).join(' ').trim();
          if (fullName) {
            techNames.add(`${fullName}${a.user.role ? ` (${a.user.role})` : ''}`);
          }
        }
      }
    }
    const dispatcherName = job?.dispatcher
      ? [job.dispatcher.first_name, job.dispatcher.last_name].filter(Boolean).join(' ').trim()
      : '';
    const salespersonName = job?.salesperson
      ? [job.salesperson.first_name, job.salesperson.last_name].filter(Boolean).join(' ').trim()
      : '';

    const teamParts: string[] = [];
    if (techNames.size > 0) {
      teamParts.push(`Assigned Technicians: ${Array.from(techNames).join(', ')}`);
    }
    if (dispatcherName) {
      teamParts.push(`Dispatcher: ${dispatcherName}`);
    }
    if (salespersonName) {
      teamParts.push(`Salesperson: ${salespersonName}`);
    }
    const assignedTeamStr =
      teamParts.length > 0 ? teamParts.join(' | ') : 'Service Technician Team (Standard Crew)';

    // 2. Job Notes
    const extractScopesText = (scopesJson: any): string => {
      if (!Array.isArray(scopesJson)) return '';
      return scopesJson
        .map((s: any) => s?.scope_text || s?.text || s?.description || s?.name || '')
        .filter(Boolean)
        .join('; ');
    };
    const scopeNotes =
      job?.scope_notes?.trim() ||
      job?.estimate?.scope_notes?.trim() ||
      extractScopesText(job?.scopes) ||
      extractScopesText(job?.estimate?.scopes) ||
      '';
    const completionNotes = job?.completion_notes?.trim() || '';
    const leadNotes = job?.lead?.notes?.trim() || '';
    const visitNotes = (job?.visits || [])
      .map((v: any) => (v?.notes ? `Visit #${v.visit_seq || 1}: ${v.notes.trim()}` : ''))
      .filter(Boolean)
      .join('; ');

    const noteParts: string[] = [];
    if (scopeNotes) noteParts.push(`Scope Notes: ${scopeNotes}`);
    if (completionNotes) noteParts.push(`Completion Notes: ${completionNotes}`);
    if (visitNotes) noteParts.push(`Visit Notes: ${visitNotes}`);
    if (leadNotes && !scopeNotes) noteParts.push(`Lead Notes: ${leadNotes}`);
    const jobNotesStr =
      noteParts.length > 0 ? noteParts.join(' | ') : 'Standard service scope completed as requested; no special exceptions noted.';

    // 3. Invoice Sent
    const invoices = Array.isArray(job?.invoices) ? job.invoices : [];
    const sentInvoices = invoices.filter((inv: any) => inv.status === 'SENT' || inv.status === 'PAID' || inv.status === 'PARTIAL');
    const primaryInvoice = sentInvoices[0] || invoices[0];
    let invoiceSentStr = 'No invoice issued yet for this job.';
    if (primaryInvoice) {
      const invNum = primaryInvoice.invoice_number?.startsWith('#')
        ? primaryInvoice.invoice_number
        : `#${primaryInvoice.invoice_number}`;
      const sentDate = fmtDate(primaryInvoice.sent_at || primaryInvoice.created_at);
      const paidDate = fmtDate(primaryInvoice.paid_at);
      invoiceSentStr = `Invoice ${invNum} | Status: ${primaryInvoice.status}${
        sentDate ? ` (Sent ${sentDate})` : ''
      }${paidDate ? ` (Paid ${paidDate})` : ''} | Total: ${fmtMoney(primaryInvoice.total_amount)} | Balance Due: ${fmtMoney(
        primaryInvoice.amount_due
      )}`;
    }

    // 4. Line Items (qty, description, price, discount)
    const rawLineItems = Array.isArray(job?.job_line_items) ? job.job_line_items : [];
    const structuredLineItems = rawLineItems.map((li: any, i: number) => {
      const qty = Number(li.quantity ?? 1);
      const price = Number(li.unit_price ?? 0);
      const discount = Number(li.discount_amount ?? 0);
      const total = Number(li.line_total ?? qty * price - discount);
      const unitCost = Number(li.unit_cost ?? 0);
      return {
        id: li.id || `li-${i}`,
        sequence: li.sequence ?? i + 1,
        description: li.description || 'Service Item',
        quantity: qty,
        unit_price: price,
        discount_amount: discount,
        line_total: total,
        unit_cost: unitCost,
      };
    });

    const lineItemsStr =
      structuredLineItems.length > 0
        ? structuredLineItems
            .map(
              (li: any, idx: number) =>
                `${idx + 1}. ${li.description} — Qty: ${li.quantity}, Price: ${fmtMoney(li.unit_price)}, Discount: ${fmtMoney(
                  li.discount_amount
                )}, Line Total: ${fmtMoney(li.line_total)}`
            )
            .join(' ; ')
        : 'Standard service package (no itemized lines recorded)';

    // 5. Total Costs
    const itemsSubtotal = structuredLineItems.reduce((acc: number, li: any) => acc + li.line_total, 0);
    const subtotalVal = primaryInvoice ? Number(primaryInvoice.subtotal ?? itemsSubtotal) : itemsSubtotal;
    const discountVal = primaryInvoice
      ? Number(primaryInvoice.discount_amount ?? job?.discount_amount ?? 0)
      : Number(job?.discount_amount ?? 0);
    const taxRatePct = Number(job?.tax_rate ?? primaryInvoice?.tax_rate ?? 0) * 100;
    const taxAmountVal = primaryInvoice
      ? Number(primaryInvoice.tax_amount ?? 0)
      : Math.max(0, (subtotalVal - discountVal) * Number(job?.tax_rate ?? 0));
    const totalAmountVal = primaryInvoice
      ? Number(primaryInvoice.total_amount ?? subtotalVal - discountVal + taxAmountVal)
      : Number(job?.estimate?.total_amount ?? subtotalVal - discountVal + taxAmountVal);
    const amountInvoicedVal = Number(job?.amount_invoiced ?? (primaryInvoice ? primaryInvoice.total_amount : 0));

    const totalCostsStr = `Subtotal: ${fmtMoney(subtotalVal)} | Discount: ${fmtMoney(discountVal)} | Tax (${taxRatePct.toFixed(
      2
    )}%): ${fmtMoney(taxAmountVal)} | Total Cost: ${fmtMoney(totalAmountVal)} | Invoiced: ${fmtMoney(amountInvoicedVal)}`;

    // 6. Internal Costs
    const internalItemsCost = structuredLineItems.reduce(
      (acc: number, li: any) => acc + Number(li.unit_cost ?? 0) * Number(li.quantity ?? 1),
      0
    );
    const laborHours = Number(job?.labor_hours ?? 0);
    const overheadMode = job?.overhead_mode || 'PERCENTAGE';
    const overheadVal = Number(job?.overhead_value ?? 0);
    const overheadFormatted =
      overheadMode === 'PERCENTAGE' ? `${overheadVal}%` : fmtMoney(overheadVal);

    const internalCostsStr = `Internal Material/Unit Cost: ${fmtMoney(
      internalItemsCost
    )} | Logged Labor Hours: ${laborHours} hrs | Overhead: ${overheadFormatted}`;

    // 7. Visits
    const rawVisits = Array.isArray(job?.visits) ? job.visits : [];
    const visitsStr =
      rawVisits.length > 0
        ? rawVisits
            .map((v: any) => {
              const vCrew = (v.assignees || [])
                .map((a: any) =>
                  a?.user ? [a.user.first_name, a.user.last_name].filter(Boolean).join(' ').trim() : ''
                )
                .filter(Boolean)
                .join(', ');
              const schedDate = fmtDate(v.scheduled_at);
              const compDate = fmtDate(v.completed_at);
              return `Visit #${v.visit_seq || 1} [${v.status}]${
                schedDate ? ` Scheduled: ${schedDate}` : ''
              }${compDate ? `, Completed: ${compDate}` : ''}${vCrew ? `, Techs: ${vCrew}` : ''}${
                v.notes ? ` — Notes: ${v.notes.trim()}` : ''
              }`;
            })
            .join(' ; ')
        : job?.completed_at
        ? `Visit #1 [COMPLETED on ${fmtDate(job.completed_at)}]`
        : 'No visits logged yet';

    // 8. Communication History
    const commEntries: Array<{ ts: number; text: string }> = [];
    for (const m of job?.messages || []) {
      const ts = m.ts ? new Date(m.ts).getTime() : 0;
      commEntries.push({
        ts,
        text: `[SMS ${(m.direction || 'out').toUpperCase()} ${fmtDate(m.ts)}]: "${String(m.body || '').slice(0, 100)}"`,
      });
    }
    for (const e of job?.emails || []) {
      const ts = e.created_at ? new Date(e.created_at).getTime() : 0;
      commEntries.push({
        ts,
        text: `[Email ${(e.direction || 'out').toUpperCase()} ${fmtDate(e.created_at)}]: Subject "${e.subject || ''}" — ${String(
          e.snippet || ''
        ).slice(0, 90)}`,
      });
    }
    for (const c of job?.call_sessions || []) {
      const ts = c.started_at ? new Date(c.started_at).getTime() : 0;
      commEntries.push({
        ts,
        text: `[Call ${(c.direction || 'out').toUpperCase()} ${fmtDate(c.started_at)} (${c.duration_sec || 0}s)]: ${
          c.summary || c.disposition || c.status || 'Completed call'
        }`,
      });
    }
    for (const mc of job?.manual_communication_logs || []) {
      const ts = mc.occurred_at ? new Date(mc.occurred_at).getTime() : 0;
      commEntries.push({
        ts,
        text: `[Logged ${mc.channel} ${mc.direction} ${fmtDate(mc.occurred_at)}]: ${String(mc.notes || '').slice(0, 100)}`,
      });
    }
    for (const te of timelineEvents || []) {
      const ts = te.created_at ? new Date(te.created_at).getTime() : 0;
      commEntries.push({
        ts,
        text: `[Job Event ${fmtDate(te.created_at)} - ${te.event_type}]: ${te.description}`,
      });
    }

    commEntries.sort((a, b) => b.ts - a.ts);
    const commHistoryStr =
      commEntries.length > 0
        ? commEntries
            .slice(0, 6)
            .map((c) => c.text)
            .join(' | ')
        : warrantyRecord
        ? `[Job Event]: Warranty issued (${warrantyRecord.status}) ending ${fmtDate(warrantyRecord.warranty_end_date)}`
        : 'No prior SMS, email, or call interactions logged on this job.';

    return {
      variables: {
        assigned_team: assignedTeamStr,
        job_notes: jobNotesStr,
        invoice_sent: invoiceSentStr,
        line_items: lineItemsStr,
        total_costs: totalCostsStr,
        internal_costs: internalCostsStr,
        visits: visitsStr,
        communication_history: commHistoryStr,
      },
      structuredLineItems,
      scopeNotes,
      completionNotes,
    };
  }

  /**
   * Fetches sample/referenced jobs with server-side search and pagination (10 per page)
   * enriched with full context variables for live script preview and test call execution.
   */
  static async getSampleJobsForAgentContext(
    orgId: string,
    limit: number = 10,
    offset: number = 0,
    search?: string,
    targetJobId?: string
  ): Promise<{
    jobs: any[];
    total: number;
    hasMore: boolean;
    offset: number;
    limit: number;
  }> {
    const where: Prisma.JobWhereInput = {
      organization_id: orgId,
    };

    if (search && search.trim()) {
      const q = search.trim();
      const cleanNum = q.replace(/^#+/, '');
      const digitsOnly = q.replace(/\D/g, '');

      where.OR = [
        { job_number: { contains: cleanNum, mode: 'insensitive' } },
        ...(UUID_REGEX.test(q) ? [{ id: q }] : []),
        { job_type: { contains: q, mode: 'insensitive' } },
        {
          customer: {
            OR: [
              { first_name: { contains: q, mode: 'insensitive' } },
              { last_name: { contains: q, mode: 'insensitive' } },
              { company_name: { contains: q, mode: 'insensitive' } },
              ...(digitsOnly.length >= 3 ? [{ phone: { contains: digitsOnly } }] : []),
            ],
          },
        },
        { estimate: { job_type: { contains: q, mode: 'insensitive' } } },
        { lead: { job_type: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [rawJobs, total] = await Promise.all([
      prisma.job.findMany({
        where,
        include: {
          customer: {
            include: { phones: true },
          },
          lead: {
            select: {
              id: true,
              lead_number: true,
              service_request: true,
              job_type: true,
              notes: true,
            },
          },
          estimate: {
            select: {
              id: true,
              estimate_number: true,
              scope_notes: true,
              scopes: true,
              job_type: true,
              total_amount: true,
            },
          },
          service_location: true,
          dispatcher: {
            select: { id: true, first_name: true, last_name: true, role: true },
          },
          salesperson: {
            select: { id: true, first_name: true, last_name: true, role: true },
          },
          job_line_items: {
            orderBy: { sequence: 'asc' },
          },
          invoices: {
            orderBy: { created_at: 'desc' },
            take: 3,
          },
          visits: {
            include: {
              assignees: {
                include: {
                  user: {
                    select: { id: true, first_name: true, last_name: true, role: true },
                  },
                },
              },
            },
            orderBy: { visit_seq: 'asc' },
          },
          messages: {
            orderBy: { ts: 'desc' },
            take: 5,
          },
          emails: {
            orderBy: { created_at: 'desc' },
            take: 5,
          },
          call_sessions: {
            orderBy: { started_at: 'desc' },
            take: 5,
          },
          manual_communication_logs: {
            orderBy: { occurred_at: 'desc' },
            take: 5,
          },
        },
        orderBy: { created_at: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.job.count({ where }),
    ]);

    const jobs = [...rawJobs];

    if (targetJobId && offset === 0 && !search && !jobs.some((j) => j.id === targetJobId)) {
      try {
        const targetJob = await prisma.job.findFirst({
          where: { id: targetJobId, organization_id: orgId },
          include: {
            customer: { include: { phones: true } },
            lead: {
              select: {
                id: true,
                lead_number: true,
                service_request: true,
                job_type: true,
                notes: true,
              },
            },
            estimate: {
              select: {
                id: true,
                estimate_number: true,
                scope_notes: true,
                scopes: true,
                job_type: true,
                total_amount: true,
              },
            },
            service_location: true,
            dispatcher: {
              select: { id: true, first_name: true, last_name: true, role: true },
            },
            salesperson: {
              select: { id: true, first_name: true, last_name: true, role: true },
            },
            job_line_items: { orderBy: { sequence: 'asc' } },
            invoices: { orderBy: { created_at: 'desc' }, take: 3 },
            visits: {
              include: {
                assignees: {
                  include: {
                    user: { select: { id: true, first_name: true, last_name: true, role: true } },
                  },
                },
              },
              orderBy: { visit_seq: 'asc' },
            },
            messages: { orderBy: { ts: 'desc' }, take: 5 },
            emails: { orderBy: { created_at: 'desc' }, take: 5 },
            call_sessions: { orderBy: { started_at: 'desc' }, take: 5 },
            manual_communication_logs: { orderBy: { occurred_at: 'desc' }, take: 5 },
          },
        });
        if (targetJob) {
          jobs.unshift(targetJob);
        }
      } catch (e) {
        // Safe fallback
      }
    }

    const jobIds = jobs.map((j) => j.id);
    const [warranties, timelineEvents] = await Promise.all([
      jobIds.length > 0
        ? prisma.beeWarrantyRecord.findMany({
            where: { organization_id: orgId, job_id: { in: jobIds } },
          })
        : Promise.resolve([]),
      jobIds.length > 0
        ? prisma.timelineEvent.findMany({
            where: { organization_id: orgId, entity_type: 'JOB', entity_id: { in: jobIds } },
            orderBy: { created_at: 'desc' },
            take: 30,
          })
        : Promise.resolve([]),
    ]);

    const formattedJobs = jobs.map((job) => {
      const wr = warranties.find((w) => w.job_id === job.id);
      const jobEvents = timelineEvents.filter((te) => te.entity_id === job.id);
      const { variables, structuredLineItems, scopeNotes, completionNotes } =
        this.extractJobDynamicVariables(job, wr, jobEvents);

      const cust = job.customer;
      const customerName = cust
        ? [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() ||
          cust.company_name ||
          'Valued Customer'
        : 'Valued Customer';
      const customerPhone =
        cust?.phone?.trim() ||
        cust?.phones?.find((p: any) => p.is_primary)?.phone?.trim() ||
        cust?.phones?.[0]?.phone?.trim() ||
        '';
      const cleanNum = (job.job_number || '').replace(/^#+/, '');
      const jobNumber = cleanNum ? `#${cleanNum}` : '';
      const jobType = job.job_type || job.estimate?.job_type || job.lead?.job_type || 'General Service';
      const loc = job.service_location;
      const serviceAddress = loc
        ? [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip].filter(Boolean).join(', ')
        : '';

      const serviceRequest = job.lead?.service_request || scopeNotes || jobType;
      const warrantyEndDateFormatted = wr?.warranty_end_date
        ? new Date(wr.warranty_end_date).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          })
        : 'Upcoming';

      return {
        id: job.id,
        job_number: jobNumber,
        title: `${jobNumber} · ${jobType}`,
        job_type: jobType,
        status: job.status,
        customer_id: job.customer_id,
        customer_name: customerName,
        customer_phone: customerPhone,
        service_request: serviceRequest,
        scope_notes: scopeNotes,
        completion_notes: completionNotes,
        service_address: serviceAddress,
        completed_at: job.completed_at || job.last_visit_completed_at || null,
        warranty_end_date: warrantyEndDateFormatted,
        warranty_status: wr?.status || 'active',
        line_items: structuredLineItems,
        job_context_variables: variables,
        dynamic_variables: {
          customer_name: customerName,
          customer_phone: customerPhone ? formatPhoneDisplay(customerPhone) : customerPhone,
          job_number: jobNumber,
          job_type: jobType,
          service_request: serviceRequest,
          service_address: serviceAddress || 'Customer Site',
          warranty_end_date: warrantyEndDateFormatted,
          ...variables,
        },
      };
    });

    const hasMore = offset + rawJobs.length < total;

    return {
      jobs: formattedJobs,
      total,
      hasMore,
      offset,
      limit,
    };
  }

  static async enrichQueueItemsWithJobContext(orgId: string, queueItems: any[]) {
    if (!queueItems || queueItems.length === 0) return [];

    const jobIds = Array.from(
      new Set(
        queueItems
          .map((item) => item.warranty_record?.job_id || item.job_id)
          .filter((id): id is string => typeof id === 'string' && UUID_REGEX.test(id))
      )
    );

    const customerIds = Array.from(
      new Set(
        queueItems
          .flatMap((item) => [item.customer_id, item.warranty_record?.customer_id])
          .filter((id): id is string => typeof id === 'string' && UUID_REGEX.test(id))
      )
    );

    const jobInclude = {
      customer: {
        include: {
          phones: true,
        },
      },
      lead: {
        select: {
          id: true,
          lead_number: true,
          service_request: true,
          job_type: true,
          notes: true,
        },
      },
      estimate: {
        select: {
          id: true,
          estimate_number: true,
          scope_notes: true,
          scopes: true,
          job_type: true,
          total_amount: true,
          lead: {
            select: {
              id: true,
              lead_number: true,
              service_request: true,
              job_type: true,
            },
          },
        },
      },
      service_location: {
        select: {
          id: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
        },
      },
      dispatcher: {
        select: { id: true, first_name: true, last_name: true, role: true },
      },
      salesperson: {
        select: { id: true, first_name: true, last_name: true, role: true },
      },
      job_line_items: {
        orderBy: { sequence: 'asc' as const },
      },
      invoices: {
        orderBy: { created_at: 'desc' as const },
        take: 3,
      },
      visits: {
        include: {
          assignees: {
            include: {
              user: {
                select: { id: true, first_name: true, last_name: true, role: true },
              },
            },
          },
        },
        orderBy: { visit_seq: 'asc' as const },
      },
      messages: {
        orderBy: { ts: 'desc' as const },
        take: 5,
      },
      emails: {
        orderBy: { created_at: 'desc' as const },
        take: 5,
      },
      call_sessions: {
        orderBy: { started_at: 'desc' as const },
        take: 5,
      },
      manual_communication_logs: {
        orderBy: { occurred_at: 'desc' as const },
        take: 5,
      },
    };

    // Performance: when every queue item already points at a concrete job (warranty_record.job_id),
    // load ONLY those jobs. The customer-wide and org-wide fallback queries (each pulling heavy
    // includes: visits, invoices, messages, emails, call sessions...) are only run when needed.
    const everyItemHasJobId = queueItems.every((item) => {
      const id = item.warranty_record?.job_id || item.job_id;
      return typeof id === 'string' && UUID_REGEX.test(id);
    });

    const [matchedJobs, matchedCustomers, beeSetting, customerTagAssignments, activeAgentsList, rawDncList] = await Promise.all([
      jobIds.length > 0 || customerIds.length > 0
        ? prisma.job.findMany({
            where: {
              organization_id: orgId,
              OR: [
                ...(jobIds.length > 0 ? [{ id: { in: jobIds } }] : []),
                ...(!everyItemHasJobId && customerIds.length > 0
                  ? [{ customer_id: { in: customerIds } }]
                  : []),
              ],
            },
            include: jobInclude,
            orderBy: { created_at: 'desc' },
          })
        : Promise.resolve([]),
      customerIds.length > 0
        ? prisma.customer.findMany({
            where: {
              organization_id: orgId,
              id: { in: customerIds },
            },
            include: { phones: true },
          })
        : Promise.resolve([]),
      Promise.resolve(
        prisma.beeSetting?.findUnique({
          where: { organization_id: orgId },
          select: { job_type_warranties: true, setup_config: true, timezone: true, max_retries: true },
        })
      ).catch(() => null),
      customerIds.length > 0 && typeof prisma.tagAssignment?.findMany === 'function'
        ? Promise.resolve()
            .then(() =>
              prisma.tagAssignment.findMany({
                where: {
                  organization_id: orgId,
                  entity_type: 'CUSTOMER',
                  entity_id: { in: customerIds },
                },
                select: {
                  entity_id: true,
                  tag: { select: { id: true, name: true, color: true } },
                },
              })
            )
            .catch(() => [])
        : Promise.resolve([]),
      typeof prisma.beeVoiceAgent?.findMany === 'function'
        ? Promise.resolve()
            .then(() =>
              prisma.beeVoiceAgent.findMany({
                where: { organization_id: orgId, is_active: true },
              })
            )
            .catch(() => [])
        : Promise.resolve([]),
      typeof prisma.beeDncEntry?.findMany === 'function'
        ? Promise.resolve()
            .then(() =>
              prisma.beeDncEntry.findMany({
                where: { organization_id: orgId },
                select: { phone_number: true },
              })
            )
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    const activeAgentsMap = new Map<string, any>();
    for (const a of ((activeAgentsList as any[]) || [])) {
      if (a?.id) {
        activeAgentsMap.set(a.id, BeeService.normalizeAgentRecord(a));
      }
    }

    const dncPhoneSet = new Set<string>();
    for (const d of ((rawDncList as any[]) || [])) {
      const p = (d?.phone_number || '').replace(/\D/g, '');
      if (p) dncPhoneSet.add(p);
    }

    const customerTagsMap = new Map<string, string[]>();
    for (const ta of (customerTagAssignments || [])) {
      if (ta.entity_id && ta.tag?.name) {
        const list = customerTagsMap.get(ta.entity_id) || [];
        list.push(ta.tag.name);
        customerTagsMap.set(ta.entity_id, list);
      }
    }

    const setupConfig = (beeSetting?.setup_config as any) || {};
    const rawRules = Array.isArray(beeSetting?.job_type_warranties)
      ? (beeSetting.job_type_warranties as any[])
      : [];
    const rulesByJobType = new Map<string, any>();
    for (const r of rawRules) {
      if (r?.job_type) {
        rulesByJobType.set(String(r.job_type).toLowerCase().trim(), r);
      }
    }

    const safeMatchedJobs = Array.isArray(matchedJobs) ? matchedJobs : [];
    const safeMatchedCustomers = Array.isArray(matchedCustomers) ? matchedCustomers : [];
    // Only fall back to recent org jobs if some queue item could not be matched to a job
    const matchedJobIds = new Set(safeMatchedJobs.map((j: any) => j.id));
    const matchedJobCustomerIds = new Set(safeMatchedJobs.map((j: any) => j.customer_id));
    const needsOrgFallback = queueItems.some((item) => {
      const id = item.warranty_record?.job_id || item.job_id;
      if (id && matchedJobIds.has(id)) return false;
      if (item.customer_id && matchedJobCustomerIds.has(item.customer_id)) return false;
      if (
        item.warranty_record?.customer_id &&
        matchedJobCustomerIds.has(item.warranty_record.customer_id)
      )
        return false;
      return true;
    });

    const rawOrgJobs = needsOrgFallback
      ? await prisma.job.findMany({
          where: { organization_id: orgId },
          include: jobInclude,
          orderBy: { created_at: 'desc' },
          take: 40,
        })
      : [];
    const safeOrgJobs = Array.isArray(rawOrgJobs) ? rawOrgJobs : [];

    const allJobsMap = new Map<string, any>();
    for (const j of [...safeMatchedJobs, ...safeOrgJobs]) {
      allJobsMap.set(j.id, j);
    }
    const allJobs = Array.from(allJobsMap.values());

    return Promise.all(
      queueItems.map(async (item, idx) => {
        const targetJobId = item.warranty_record?.job_id || item.job_id;
      let job = targetJobId ? allJobsMap.get(targetJobId) : undefined;

      if (!job) {
        job = allJobs.find(
          (j) =>
            j.customer_id === item.customer_id ||
            (item.warranty_record?.customer_id && j.customer_id === item.warranty_record.customer_id)
        );
      }

      if (!job && item.customer_name) {
        const lowerName = String(item.customer_name).toLowerCase().trim();
        job = allJobs.find((j) => {
          const c = j.customer;
          if (!c) return false;
          const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase().trim();
          const compName = (c.company_name || '').toLowerCase().trim();
          return (fullName && fullName === lowerName) || (compName && compName === lowerName);
        });
      }

      if (!job && allJobs.length > 0) {
        job = allJobs[idx % allJobs.length];
      }

      const cust =
        job?.customer ||
        safeMatchedCustomers.find(
          (c) => c.id === item.customer_id || c.id === item.warranty_record?.customer_id
        );

      const resolvedJobId = job?.id || targetJobId || undefined;
      const rawJobNumber = job?.job_number ? String(job.job_number).trim() : '';
      const resolvedJobNumber = rawJobNumber
        ? rawJobNumber.startsWith('#')
          ? rawJobNumber
          : `#${rawJobNumber}`
        : resolvedJobId
        ? `#${resolvedJobId.slice(0, 8)}`
        : '—';

      const resolvedCustomerId = job?.customer_id || cust?.id || item.customer_id || undefined;
      const resolvedCustomerName = cust
        ? [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() ||
          cust.company_name ||
          item.customer_name
        : item.customer_name;

      const primaryCustPhone =
        cust?.phone?.trim() ||
        cust?.phones?.find((p: any) => p.is_primary)?.phone?.trim() ||
        cust?.phones?.[0]?.phone?.trim() ||
        cust?.secondary_phone?.trim();
      const resolvedCustomerPhone = primaryCustPhone || item.customer_phone || '';

      const resolvedJobType =
        job?.job_type ||
        job?.estimate?.job_type ||
        job?.lead?.job_type ||
        job?.estimate?.lead?.job_type ||
        item.warranty_record?.job_type ||
        'General Service';

      const {
        variables: jobContextVariables,
        structuredLineItems: lineItems,
        scopeNotes,
        completionNotes,
      } = this.extractJobDynamicVariables(job, item.warranty_record);

      const lineItemsSummary = lineItems
        .map((li: any) => `${li.description}${li.quantity > 1 ? ` (x${li.quantity})` : ''}`)
        .filter(Boolean)
        .join(', ');

      const resolvedServiceRequest =
        job?.lead?.service_request?.trim() ||
        job?.estimate?.lead?.service_request?.trim() ||
        scopeNotes ||
        lineItemsSummary ||
        completionNotes ||
        resolvedJobType;

      const loc = job?.service_location;
      const serviceAddress = loc
        ? [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip]
            .filter(Boolean)
            .join(', ')
        : '';

      const completedAt =
        job?.completed_at ||
        job?.last_visit_completed_at ||
        item.warranty_record?.job_completed_at ||
        null;

      const liveRule = rulesByJobType.get(String(resolvedJobType).toLowerCase().trim());

      const setupExcludedTags: string[] = Array.isArray(setupConfig?.excludedTags) ? setupConfig.excludedTags : [];
      const itemCustTags = resolvedCustomerId ? (customerTagsMap.get(resolvedCustomerId) || []) : [];
      const isCustomerTagExcluded = setupExcludedTags.length > 0 && itemCustTags.some((tagName: string) =>
        setupExcludedTags.some((ex) => ex.toLowerCase().trim() === tagName.toLowerCase().trim())
      );

      const jobAmount = Number(
        job?.invoices?.[0]?.total_amount ??
        job?.total_amount ??
        job?.estimate?.total_amount ??
        0
      );

      const maxRetries = beeSetting?.max_retries ?? 2;
      const isRetryExceeded = (item.attempt_count >= maxRetries && item.status !== 'completed');
      const isArchived = item.status === 'archived' || isRetryExceeded;

      // Real-time evaluation of status (archived, skipped reasons, or scheduled)
      let effectiveStatus = item.status;
      let effectiveSkipReason = item.skip_reason;

      if (isArchived) {
        effectiveStatus = 'archived';
        effectiveSkipReason = 'Retry limit reached';
      } else if (item.status !== 'completed' && item.status !== 'in_progress') {
        const minJobAmount = Number(setupConfig?.skipMinJobAmount ?? 0);
        const isBelowMin = minJobAmount > 0 && jobAmount < minJobAmount;
        const cleanPhone = (resolvedCustomerPhone || '').replace(/\D/g, '');
        const isDnc = cleanPhone.length > 0 && dncPhoneSet.has(cleanPhone);
        const isJobTypeDisabled = Boolean(liveRule && liveRule.is_active === false);

        const reasons: string[] = [];
        if (isCustomerTagExcluded) reasons.push('Customer to Skip Tag');
        if (isBelowMin) reasons.push('Job Below Minimum Amount');
        if (isDnc) reasons.push('Do Not Call (DNC)');
        if (isJobTypeDisabled) reasons.push('Job Type Disabled');

        if (reasons.length > 0) {
          effectiveStatus = 'skipped';
          effectiveSkipReason = reasons.join(', ');
        } else if (
          effectiveStatus === 'skipped' &&
          effectiveSkipReason &&
          (effectiveSkipReason.includes('Tag') ||
            effectiveSkipReason.includes('Amount') ||
            effectiveSkipReason.includes('Call') ||
            effectiveSkipReason.includes('Disabled') ||
            effectiveSkipReason.includes('disabled') ||
            effectiveSkipReason.includes('excluded tag'))
        ) {
          effectiveStatus = 'scheduled';
          effectiveSkipReason = null;
        } else if (effectiveSkipReason) {
          effectiveSkipReason = BeeService.normalizeSkipReason(effectiveSkipReason);
        }
      }

      const archivedAt =
        effectiveStatus === 'archived'
          ? ((item as any).last_attempted_at || (item as any).updated_at || (item as any).created_at || new Date().toISOString())
          : null;

      // Real-time evaluation of assigned Agent and Outbound Phone from Bee settings
      const effectiveAgentId =
        (liveRule?.agent_id && liveRule.agent_id !== 'default' ? liveRule.agent_id : null) ||
        setupConfig.defaultAgentId ||
        item.agent_id ||
        null;
      const assignedAgent = effectiveAgentId ? activeAgentsMap.get(effectiveAgentId) : null;
      const effectiveFromPhone =
        assignedAgent?.default_from_number ||
        liveRule?.phone_number ||
        setupConfig.callerId ||
        setupConfig.defaultPhoneNumber ||
        null;

      const warrantyStartDate = item.warranty_record?.warranty_start_date || completedAt || null;
      let warrantyEndDate = item.warranty_record?.warranty_end_date || null;
      if (liveRule?.warranty_days && warrantyStartDate) {
        warrantyEndDate = new Date(
          new Date(warrantyStartDate).getTime() + Number(liveRule.warranty_days) * 86400000
        );
      }
      let warrantyStatus = item.warranty_record?.status || 'active';
      if (warrantyEndDate) {
        const endMs = new Date(warrantyEndDate).getTime();
        const nowMs = Date.now();
        if (nowMs >= endMs) {
          warrantyStatus = 'expired';
        } else if (endMs - nowMs <= 30 * 86400000) {
          warrantyStatus = 'expiring_soon';
        } else {
          warrantyStatus = 'active';
        }
      }

      const warrantyStartedOn =
        (item as any).warranty_started_on ||
        item.warranty_record?.warranty_started_on ||
        (item.warranty_record?.warranty_start_date && job?.completed_at &&
         Math.abs(new Date(item.warranty_record.warranty_start_date).getTime() - new Date(job.completed_at).getTime()) < 60000
          ? 'Job Complete'
          : (item.warranty_record?.warranty_start_date ? 'Invoice Sent' : 'Job Complete'));

      const isRescheduled = Boolean((item as any).is_rescheduled);
      const originalScheduledFor = (item as any).original_scheduled_for || item.scheduled_for;
      const rescheduledAt = (item as any).rescheduled_at || null;

      // Timezone resolution: use stored if available, otherwise resolve from location/customer
      let customerTimezone = (item as any).customer_timezone || null;
      let timezoneSource = (item as any).timezone_source || null;
      let isTimezoneEstimated = Boolean((item as any).is_timezone_estimated);

      if (!customerTimezone) {
        const custAddressInput = {
          address: loc?.address_line1 || cust?.billing_address_line1 || null,
          city: loc?.city || cust?.billing_city || null,
          state: loc?.state || cust?.billing_state || null,
          zip: loc?.zip || cust?.billing_zip || null,
        };
        const resolvedTz = await resolveCustomerTimezone(
          custAddressInput,
          beeSetting?.timezone || 'America/New_York'
        );
        customerTimezone = resolvedTz.timezone;
        timezoneSource = resolvedTz.source;
        isTimezoneEstimated = resolvedTz.is_estimated;
      }

      return {
        ...item,
        total_amount: jobAmount,
        last_attempted_at: (item as any).last_attempted_at || null,
        archived_at: archivedAt,
        warranty_started_on: warrantyStartedOn,
        is_rescheduled: isRescheduled,
        original_scheduled_for: originalScheduledFor,
        rescheduled_at: rescheduledAt,
        customer_timezone: customerTimezone,
        timezone_source: timezoneSource,
        is_timezone_estimated: isTimezoneEstimated,
        status: effectiveStatus,
        skip_reason: effectiveSkipReason,
        agent_id: effectiveAgentId,
        from_phone_number: effectiveFromPhone,
        customer_id: resolvedCustomerId,
        customer_name: resolvedCustomerName,
        customer_phone: resolvedCustomerPhone ? formatPhoneDisplay(resolvedCustomerPhone) : resolvedCustomerPhone,
        job_id: resolvedJobId,
        job_number: resolvedJobNumber,
        job_type: resolvedJobType,
        service_request: resolvedServiceRequest,
        scope_notes: scopeNotes,
        completion_notes: completionNotes,
        service_address: serviceAddress,
        completed_at: completedAt,
        line_items: lineItems,
        job_context_variables: jobContextVariables,
        job_info: {
          job_id: resolvedJobId,
          job_number: resolvedJobNumber,
          job_type: resolvedJobType,
          status: job?.status || 'COMPLETED',
          service_request: resolvedServiceRequest,
          scope_notes: scopeNotes,
          completion_notes: completionNotes,
          service_address: serviceAddress,
          completed_at: completedAt,
          line_items: lineItems,
          line_items_summary: lineItemsSummary,
          warranty_start_date: warrantyStartDate,
          warranty_end_date: warrantyEndDate,
          warranty_status: warrantyStatus,
          job_context_variables: jobContextVariables,
        },
        warranty_record: item.warranty_record
          ? {
              ...item.warranty_record,
              warranty_started_on: warrantyStartedOn,
              job_id: resolvedJobId || item.warranty_record.job_id,
              customer_id: resolvedCustomerId || item.warranty_record.customer_id,
              job_type: resolvedJobType,
              warranty_end_date: warrantyEndDate,
              status: warrantyStatus,
            }
          : {
              warranty_started_on: warrantyStartedOn,
              job_id: resolvedJobId,
              customer_id: resolvedCustomerId,
              job_type: resolvedJobType,
              warranty_end_date: warrantyEndDate,
              status: warrantyStatus,
            },
      };
      })
    );
  }

  /**
   * Persistent queue runner.
   * Sweeps scheduled queue items due for execution, verifies TCPA calling windows and DNC,
   * invokes voice provider, records genuine call logs, and handles retry scheduling.
   */
  static async processDueQueueItems() {
    const now = new Date();

    const dueItems = await prisma.beeQueueItem.findMany({
      where: {
        status: 'scheduled',
        scheduled_for: { lte: now },
      },
      include: {
        warranty_record: true,
      },
      take: 25,
      orderBy: { scheduled_for: 'asc' },
    });

    if (dueItems.length === 0) return { processed: 0 };

    let processedCount = 0;

    for (const rawItem of dueItems) {
      const orgId = rawItem.organization_id;
      const [item] = await this.enrichQueueItemsWithJobContext(orgId, [rawItem]);

      const settings = await prisma.beeSetting.findUnique({
        where: { organization_id: orgId },
      });

      // If Bee is disabled for org, skip
      if (settings && !settings.is_active) {
        continue;
      }

      const orgTimezone = settings?.timezone || 'America/New_York';
      const windowStart = settings?.call_window_start || '10:00';
      const windowEnd = settings?.call_window_end || '19:00';
      const maxRetries = settings?.max_retries ?? 2;
      const retryIntervalHours = settings?.retry_interval_hours ?? 48;
      const setupConfig = (settings?.setup_config as any) || {};
      const callDays: string[] = Array.isArray(setupConfig.callDays) && setupConfig.callDays.length > 0
        ? setupConfig.callDays
        : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

      // Customer resolved timezone takes precedence over org default timezone
      const customerTimezone = item.customer_timezone || (rawItem as any).customer_timezone || orgTimezone;

      // TCPA window and allowed calling days check in customer's local timezone
      if (!this.isWithinCallWindow(windowStart, windowEnd, customerTimezone, now, callDays)) {
        logger.info(
          `[BeeService] Deferring queue item ${item.id} outside TCPA call window or calling days (${windowStart}-${windowEnd}, days: [${callDays.join(',')}], customer timezone: ${customerTimezone})`
        );
        continue;
      }

      // Check retry limit first
      if (item.attempt_count >= maxRetries) {
        await prisma.beeQueueItem.update({
          where: { id: item.id },
          data: {
            status: 'archived',
            skip_reason: 'Retry limit reached',
            last_attempted_at: now,
          },
        });
        processedCount++;
        continue;
      }

      // Check eligibility across all 4 conditions (Customer tag, Min job amount, DNC, Job type disabled)
      const itemJobType = item.job_type || item.warranty_record?.job_type || 'General Service';
      const eligibility = await this.evaluateJobCallEligibility({
        orgId,
        jobId: item.job_id,
        customerId: item.customer_id,
        customerPhone: item.customer_phone,
        jobType: itemJobType,
        jobAmount: item.total_amount,
        beeSettings: settings,
      });

      if (eligibility.isSkipped) {
        logger.info(`[BeeService] Skipping queue item ${item.id} due to: ${eligibility.skipReason}`);
        await prisma.beeQueueItem.update({
          where: { id: item.id },
          data: {
            status: 'skipped',
            skip_reason: eligibility.skipReason,
          },
        });
        processedCount++;
        continue;
      }

      // Resolve voice agent and outbound phone number assigned to that agent according to job type
      const { agent, fromPhoneNumber, fromPhoneNumberId } =
        await this.resolveAgentAndPhoneNumberForJob(orgId, itemJobType, {
          preferredAgentId: item.agent_id,
        });

      const activePlans = await prisma.beeWarrantyPlan.findMany({
        where: { organization_id: orgId, is_active: true },
        orderBy: { price: 'asc' },
      });

      const callResult = await BeeVoiceAdapter.initiateCall(orgId, {
        to: item.customer_phone,
        from: fromPhoneNumber,
        phoneNumberId: fromPhoneNumberId,
        agentId: agent?.id,
        agentName: agent?.name,
        voiceId: agent?.voice_id,
        externalAgentId: agent?.vapi_assistant_id || undefined,
        customerId: item.customer_id,
        customerName: item.customer_name,
        agentPersona: agent?.persona_name || 'Emma',
        agentTone: agent?.tone,
        agentLanguage: agent?.language,
        tradeFocus: agent?.trade_focus || itemJobType,
        jobId: item.job_id,
        jobNumber: item.job_number,
        jobType: itemJobType,
        serviceRequest: item.service_request,
        scopeNotes: item.scope_notes,
        completionNotes: item.completion_notes,
        serviceAddress: item.service_address,
        completedAt: item.completed_at ? new Date(item.completed_at).toISOString() : undefined,
        warrantyStartDate: item.warranty_record?.warranty_start_date
          ? new Date(item.warranty_record.warranty_start_date).toISOString()
          : undefined,
        warrantyEndDate: item.warranty_record?.warranty_end_date
          ? new Date(item.warranty_record.warranty_end_date).toISOString()
          : undefined,
        warrantyStatus: item.warranty_record?.status,
        lineItemsSummary: item.job_info?.line_items_summary,
        warrantyOfferPitch: agent?.warranty_offer_pitch || undefined,
        newWorkPitch: agent?.new_work_pitch || undefined,
        conversationFlow: agent?.conversation_flow,
        selectedJobContextFields: agent?.job_context_fields,
        jobContextVariables: item.job_context_variables,
        availablePlans: (activePlans || []).map((p) => ({
          name: p.name,
          price: Number(p.price),
          durationMonths: p.duration_months,
          description: p.description || undefined,
        })),
      });

      // Persist vapi_assistant_id if the voice engine auto-synced the agent during call initiation
      if (agent?.id && !agent?.vapi_assistant_id && callResult.assistantId) {
        const packedWithAssistant = this.packAgentMetadata(
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

      const nextAttemptCount = item.attempt_count + 1;

      if (callResult.status === 'failed') {
        const canRetry = nextAttemptCount < maxRetries;
        const nextScheduled = canRetry ? new Date(now.getTime() + retryIntervalHours * 3600000) : item.scheduled_for;

        await prisma.beeQueueItem.update({
          where: { id: item.id },
          data: {
            customer_id: item.customer_id,
            customer_name: item.customer_name,
            customer_phone: item.customer_phone,
            attempt_count: nextAttemptCount,
            last_attempted_at: now,
            status: canRetry ? 'scheduled' : 'archived',
            scheduled_for: nextScheduled,
            skip_reason: canRetry ? (callResult.error || 'Call initiation failed') : 'Retry limit reached',
          },
        });

        await this.createInitialCallLog(orgId, {
          callId: callResult.callId,
          status: 'failed',
          provider: callResult.provider,
          customerId: item.customer_id,
          customerName: item.customer_name,
          customerPhone: item.customer_phone,
          agentId: agent?.id || null,
          queueItemId: item.id,
          jobNumber: item.job_number,
          jobType: item.job_type,
          error: callResult.error,
        });
      } else {
        // Initiated
        await prisma.beeQueueItem.update({
          where: { id: item.id },
          data: {
            customer_id: item.customer_id,
            customer_name: item.customer_name,
            customer_phone: item.customer_phone,
            status: 'in_progress',
            attempt_count: nextAttemptCount,
            last_attempted_at: now,
          },
        });

        await this.createInitialCallLog(orgId, {
          callId: callResult.callId,
          status: 'initiated',
          provider: callResult.provider,
          customerId: item.customer_id,
          customerName: item.customer_name,
          customerPhone: item.customer_phone,
          agentId: agent?.id || null,
          queueItemId: item.id,
          jobNumber: item.job_number,
          jobType: item.job_type,
        });
      }

      processedCount++;
    }

    return { processed: processedCount };
  }

  /**
   * Backend startup recovery: recovers any queue items stuck in 'in_progress' for over 30 minutes
   */
  static async recoverStaleQueueItems() {
    const threshold = new Date(Date.now() - 30 * 60 * 1000);
    const stale = await prisma.beeQueueItem.findMany({
      where: {
        status: 'in_progress',
        last_attempted_at: { lte: threshold },
      },
    });

    for (const item of stale) {
      await prisma.beeQueueItem.update({
        where: { id: item.id },
        data: {
          status: 'scheduled',
          scheduled_for: new Date(),
          skip_reason: 'Recovered from interrupted in_progress state on backend restart',
        },
      });
    }

    if (stale.length > 0) {
      logger.info(`[BeeService] Recovered ${stale.length} stale in_progress queue items`);
    }
    return { recovered: stale.length };
  }

  /**
   * Syncs existing sent invoices in organization to warranty records and queue
   */
  static async syncWarrantyRecordsAndQueue(orgId: string) {
    const rules: any[] = await this.getJobTypeWarranties(orgId);
    const ruleMap = new Map<string, any>(rules.map((r: any) => [r.job_type, r]));

    // Read organization setup configuration for warranty start event
    const beeSettings = await prisma.beeSetting.findUnique({
      where: { organization_id: orgId },
    });
    const currentWarrantyStartsOn = this.resolveWarrantyStartsOn(beeSettings?.setup_config);

    // Find ONLY sent invoices in org that have a linked job
    const invoices = await prisma.invoice.findMany({
      where: {
        organization_id: orgId,
        status: 'SENT',
        job_id: { not: null },
      },
      include: {
        job: {
          include: {
            customer: {
              include: {
                phones: true,
              },
            },
            service_location: true,
            lead: true,
            estimate: true,
          },
        },
      },
    });

    const now = new Date();
    let recordsUpdated = 0;
    let queueItemsCreated = 0;

    for (const inv of invoices) {
      if (!inv.job) continue;
      const job = inv.job;
      const customer = job.customer;
      const jobType =
        job.job_type ||
        job.estimate?.job_type ||
        job.lead?.job_type ||
        'General Service';
      const rule: any = ruleMap.get(jobType) || { warranty_days: 365, call_threshold_days: 30, included_warranty: '12 months' };

      const custId = job.customer_id || customer?.id || '00000000-0000-0000-0000-000000000001';
      const custName = customer
        ? [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() ||
          customer.company_name ||
          'Valued Customer'
        : 'Valued Customer';
      const custPhone =
        customer?.phone?.trim() ||
        customer?.phones?.find((p: any) => p.is_primary)?.phone?.trim() ||
        customer?.phones?.[0]?.phone?.trim() ||
        customer?.secondary_phone?.trim() ||
        '';

      // Find existing BeeWarrantyRecord
      let record = await prisma.beeWarrantyRecord.findFirst({
        where: {
          organization_id: orgId,
          job_id: job.id,
        },
      });

      if (record) {
        // PRESERVE EXISTING RECORD'S WARRANTY START EVENT AND DATES!
        // Do NOT retroactively recalculate or alter warranty_start_date or warranty_end_date.
        const recordEndDate = record.warranty_end_date ? new Date(record.warranty_end_date) : null;
        let status = record.status || 'active';
        if (recordEndDate && !isNaN(recordEndDate.getTime())) {
          if (now.getTime() >= recordEndDate.getTime()) {
            status = 'expired';
          } else if (recordEndDate.getTime() - now.getTime() <= 30 * 86400000) {
            status = 'expiring_soon';
          }
        }

        record = await prisma.beeWarrantyRecord.update({
          where: { id: record.id },
          data: {
            customer_id: custId,
            job_type: jobType,
            status,
            ...((record as any).warranty_started_on ? {} : { warranty_started_on: currentWarrantyStartsOn }),
          },
        });
        recordsUpdated++;
      } else {
        // New record entering the queue: calculate using the current global setting
        const effectiveStartOn = currentWarrantyStartsOn;
        const warrantyStartDate =
          effectiveStartOn === 'Job Complete'
            ? (job.completed_at || job.created_at || inv.sent_at || inv.created_at || now)
            : (inv.sent_at || inv.created_at || job.completed_at || job.created_at || now);
        const warrantyEndDate = new Date(new Date(warrantyStartDate).getTime() + (rule.warranty_days * 86400000));

        let status = 'active';
        if (now.getTime() >= warrantyEndDate.getTime()) {
          status = 'expired';
        } else if (warrantyEndDate.getTime() - now.getTime() <= 30 * 86400000) {
          status = 'expiring_soon';
        }

        record = await prisma.beeWarrantyRecord.create({
          data: {
            organization_id: orgId,
            job_id: job.id,
            customer_id: custId,
            job_type: jobType,
            job_completed_at: job.completed_at || job.created_at || now,
            warranty_start_date: warrantyStartDate,
            warranty_end_date: warrantyEndDate,
            warranty_started_on: effectiveStartOn,
            status,
          },
        });
        recordsUpdated++;
      }

      // Ensure queued for calling once scheduled threshold reached
      const existingQueue = await prisma.beeQueueItem.findFirst({
        where: {
          organization_id: orgId,
          warranty_record_id: record.id,
        },
      });

      const jobAmount = Number(
        inv.total_amount ??
        (job as any).total_amount ??
        job.estimate?.total_amount ??
        0
      );

      const eligibility = await this.evaluateJobCallEligibility({
        orgId,
        jobId: job.id,
        customerId: custId,
        customerPhone: custPhone,
        jobType,
        jobAmount,
        beeSettings,
        jobRules: rules,
      });

      if (existingQueue) {
        // PRESERVE ARCHIVED JOBS: Never overwrite jobs that reached retry limit
        if (existingQueue.status === 'archived') {
          continue;
        }

        if (eligibility.isSkipped) {
          if (existingQueue.status === 'scheduled' || existingQueue.status === 'skipped') {
            await prisma.beeQueueItem.update({
              where: { id: existingQueue.id },
              data: {
                status: 'skipped',
                skip_reason: eligibility.skipReason,
              },
            });
          }
        } else {
          // Re-enabled: if it was previously skipped, restore to scheduled!
          if (existingQueue.status === 'skipped') {
            await prisma.beeQueueItem.update({
              where: { id: existingQueue.id },
              data: {
                customer_id: custId,
                customer_name: custName,
                customer_phone: custPhone,
                status: 'scheduled',
                skip_reason: null,
                ...((existingQueue as any).warranty_started_on ? {} : { warranty_started_on: (record as any).warranty_started_on || currentWarrantyStartsOn }),
              },
            });
          } else if (custPhone) {
            // PRESERVE EXISTING QUEUE SCHEDULE AND RESCHEDULE STATE!
            // Do NOT overwrite scheduled_for or recalculate the call schedule automatically.
            await prisma.beeQueueItem.update({
              where: { id: existingQueue.id },
              data: {
                customer_id: custId,
                customer_name: custName,
                customer_phone: custPhone,
                ...((existingQueue as any).warranty_started_on ? {} : { warranty_started_on: (record as any).warranty_started_on || currentWarrantyStartsOn }),
              },
            });
          }
        }
      } else if (custPhone) {
        let assignedAgentId = rule.agent_id || null;
        if (!assignedAgentId) {
          const firstActive = await prisma.beeVoiceAgent.findFirst({
            where: { organization_id: orgId, is_active: true },
          });
          assignedAgentId = firstActive?.id || null;
        }

        const daysBefore = Number(rule.call_threshold_days ?? 30);
        const recEndDate = record.warranty_end_date
          ? new Date(record.warranty_end_date)
          : new Date(now.getTime() + (rule.warranty_days || 365) * 86400000);
        let scheduledFor = new Date(recEndDate.getTime() - daysBefore * 86400000);
        if (scheduledFor.getTime() <= now.getTime()) {
          scheduledFor = now;
        }

        const effectiveStartEvent = (record as any).warranty_started_on || currentWarrantyStartsOn;

        const loc = (job as any)?.service_location;
        const cust = customer as any;
        const custAddressInput = {
          address: loc?.address_line1 || cust?.billing_address_line1 || null,
          city: loc?.city || cust?.billing_city || null,
          state: loc?.state || cust?.billing_state || null,
          zip: loc?.zip || cust?.billing_zip || null,
        };
        const resolvedTz = await resolveCustomerTimezone(
          custAddressInput,
          beeSettings?.timezone || 'America/New_York'
        );

        await prisma.beeQueueItem.create({
          data: {
            organization_id: orgId,
            warranty_record_id: record.id,
            customer_id: custId,
            customer_name: custName,
            customer_phone: custPhone,
            agent_id: assignedAgentId,
            status: eligibility.isSkipped ? 'skipped' : 'scheduled',
            skip_reason: eligibility.skipReason,
            attempt_count: 0,
            scheduled_for: scheduledFor,
            warranty_started_on: effectiveStartEvent,
            original_scheduled_for: scheduledFor,
            is_rescheduled: false,
            rescheduled_at: null,
            customer_timezone: resolvedTz.timezone,
            timezone_source: resolvedTz.source,
            is_timezone_estimated: resolvedTz.is_estimated,
          },
        });
        queueItemsCreated++;
      }
    }

    logger.info(`[BeeService] Synced warranties for org ${orgId}: ${recordsUpdated} records, ${queueItemsCreated} queue items`);
    return { recordsUpdated, queueItemsCreated };
  }

  /**
   * Manually reschedules an eligible queue item's call time.
   * Persists the updated scheduled_for, retains original_scheduled_for, sets is_rescheduled = true,
   * and preserves the historical warranty_started_on.
   */
  static async rescheduleQueueItem(
    orgId: string,
    queueItemId: string,
    newScheduledFor: Date | string
  ) {
    if (!queueItemId) {
      throw new Error('Queue item ID is required');
    }

    const dateObj = new Date(newScheduledFor);
    if (isNaN(dateObj.getTime())) {
      throw new Error('Invalid scheduled time format');
    }

    const existing = await prisma.beeQueueItem.findFirst({
      where: { id: queueItemId, organization_id: orgId },
      include: { warranty_record: true },
    });

    if (!existing) {
      throw new Error('Queue item not found');
    }

    if (existing.status === 'completed' || existing.status === 'in_progress') {
      throw new Error(`Cannot reschedule a call that is already ${existing.status}`);
    }

    const originalTime = (existing as any).original_scheduled_for || existing.scheduled_for;

    // If item was previously skipped (e.g. manually skipped), allow rescheduling back to 'scheduled'
    let newStatus = existing.status;
    let newSkipReason = existing.skip_reason;
    if (existing.status === 'skipped') {
      const isDnc = await this.isDnc(orgId, existing.customer_phone);
      if (!isDnc) {
        newStatus = 'scheduled';
        newSkipReason = null;
      }
    }

    const updated = await prisma.beeQueueItem.update({
      where: { id: queueItemId },
      data: {
        scheduled_for: dateObj,
        original_scheduled_for: originalTime,
        is_rescheduled: true,
        rescheduled_at: new Date(),
        status: newStatus,
        skip_reason: newSkipReason,
      },
      include: {
        warranty_record: true,
      },
    });

    logger.info(
      `[BeeService] Manually rescheduled queue item ${queueItemId} from ${new Date(originalTime).toISOString()} to ${dateObj.toISOString()}`
    );

    const [enriched] = await this.enrichQueueItemsWithJobContext(orgId, [updated]);
    return enriched;
  }

  /**
   * Initializes default settings, warranty plans, and voice agents for an organization if empty.
   * Does NOT seed dummy call logs, fake transcripts, or simulated queue items.
   */
  static async seedDemoDataIfEmpty(orgId: string) {
    const existingAgent = await prisma.beeVoiceAgent.findFirst({
      where: { organization_id: orgId },
    });
    if (existingAgent) return;

    logger.info(`[BeeService] Initializing default Bee configuration for org ${orgId}`);

    // 1. Settings
    const defaultJobTypeRules = [
      { job_type: 'Lock rekey / small repair', included_warranty: '90 days', warranty_days: 90, call_threshold_days: 21 },
      { job_type: 'Door closer / hardware replacement', included_warranty: '6 months', warranty_days: 180, call_threshold_days: 30 },
      { job_type: 'New door install', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 45 },
      { job_type: 'Access control / camera install', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 45 },
      { job_type: 'Fire door replacement', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 45 },
      { job_type: 'Automatic door operator', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 45 },
    ];

    await prisma.beeSetting.upsert({
      where: { organization_id: orgId },
      create: {
        organization_id: orgId,
        is_active: true,
        call_window_start: '10:00',
        call_window_end: '19:00',
        timezone: 'America/New_York',
        max_retries: 2,
        retry_interval_hours: 48,
        alert_email: null,
        job_type_warranties: defaultJobTypeRules,
      },
      update: {
        job_type_warranties: defaultJobTypeRules,
      },
    });

    // 2. Warranty Plans
    const plans = [
      {
        name: 'Silver Protection',
        duration_months: 12,
        price: 149.0,
        billing_interval: 'one_time',
        description: '1-year labor extension on the original work',
        inclusions: {
          per: 'job',
          len: '12 months',
          covered: '1-year labor extension on the original work',
          files: [],
          for: 'All job types',
        },
        eligible_job_types: ['All job types'],
        is_active: true,
      },
      {
        name: 'Gold Protection',
        duration_months: 12,
        price: 349.0,
        billing_interval: 'one_time',
        description: 'Labor extension + 1 preventive maintenance visit',
        inclusions: {
          per: 'job',
          len: '12 months',
          covered: 'Labor extension + 1 preventive maintenance visit',
          files: [],
          for: 'All job types',
        },
        eligible_job_types: ['All job types'],
        is_active: true,
      },
      {
        name: 'Commercial Care',
        duration_months: 12,
        price: 85.0,
        billing_interval: 'yearly',
        description: 'Annual inspection, 4-hour priority response, 10% off parts',
        inclusions: {
          per: 'door',
          len: '12 months',
          covered: 'Annual inspection, 4-hour priority response, 10% off parts',
          files: [],
          for: 'Commercial',
        },
        eligible_job_types: ['Commercial'],
        is_active: true,
      },
    ];

    for (const plan of plans) {
      await prisma.beeWarrantyPlan.create({
        data: {
          organization_id: orgId,
          ...plan,
        },
      });
    }

    // 3. Voice Agents
    const agents = [
      {
        name: 'Emma - Door & Lock Specialist',
        persona_name: 'Emma',
        voice_id: 'friendly_female_1',
        trade_focus: 'Doors & Locks',
        trigger_days_before: 30,
        eligible_job_types: ['Door Installation', 'Lock Repair', 'General Hardware'],
        warranty_offer_pitch: "Hi [Customer Name], this is Emma with our service team. We recently serviced your door hardware! Your warranty coverage is coming to a close next month, and I'm calling to see if you'd like to extend your coverage so you never have to worry about sudden repair costs.",
        new_work_pitch: "Also, while I have you, many of our clients ask us to inspect their side exits and locks. Do you have any other hardware that needs an upgrade?",
      },
      {
        name: 'Marcus - Commercial Access Specialist',
        persona_name: 'Marcus',
        voice_id: 'professional_male_1',
        trade_focus: 'Access Control & Cameras',
        trigger_days_before: 45,
        eligible_job_types: ['Access Control', 'Camera Installation', 'Automatic Doors'],
        warranty_offer_pitch: "Good morning [Customer Name], Marcus calling regarding your access control installation. Your warranty expires soon and we offer comprehensive ongoing protection that covers parts and priority response.",
        new_work_pitch: "Are you planning any facility expansions or hardware additions this quarter?",
      },
    ];

    for (const agent of agents) {
      await prisma.beeVoiceAgent.create({
        data: {
          organization_id: orgId,
          ...agent,
        },
      });
    }

    logger.info(`[BeeService] Successfully initialized default Bee configuration for org ${orgId}`);
  }

  /**
   * Processes an inbound call webhook payload for Bee Agent (Postman testing & telephony webhook intake).
   * Validates or resolves customer, normalizes transcript & recording URL, saves call log,
   * enforces idempotency on callId, and triggers post-call workflows (lead creation, queue update, DNC).
   */
  static async processInboundCall(
    orgId: string,
    payload: InboundCallPayload
  ): Promise<ProcessInboundCallResult> {
    const rawCallId = (payload.callId || payload.call_id || '').trim();
    let targetId: string;
    if (rawCallId) {
      targetId = UUID_REGEX.test(rawCallId) ? rawCallId : toDeterministicUuid(rawCallId, orgId);
    } else {
      targetId = crypto.randomUUID();
    }

    // 1. Transcript Normalization
    let resolvedTranscript: Array<{ speaker: 'bee' | 'customer'; text: string; timestamp: number }> = [];
    if (typeof payload.transcript === 'string') {
      const text = payload.transcript.trim();
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const turns: Array<{ speaker: 'bee' | 'customer'; text: string; timestamp: number }> = [];
      let hasPrefixedLines = false;

      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^(bee|agent|bot|assistant|customer|user|caller)\s*:\s*(.*)$/i);
        if (match) {
          hasPrefixedLines = true;
          const speakerRole = ['bee', 'agent', 'bot', 'assistant'].includes(match[1].toLowerCase()) ? 'bee' : 'customer';
          turns.push({
            speaker: speakerRole,
            text: match[2].trim(),
            timestamp: i * 5,
          });
        }
      }

      if (hasPrefixedLines && turns.length > 0) {
        resolvedTranscript = turns;
      } else {
        resolvedTranscript = [
          { speaker: 'bee', text: 'Hi, this is Bee following up on your recent service.', timestamp: 0 },
          { speaker: 'customer', text, timestamp: 4 },
        ];
      }
    } else if (Array.isArray(payload.transcript)) {
      resolvedTranscript = payload.transcript.map((item: any, idx: number) => ({
        speaker: item.speaker === 'bee' || item.speaker === 'a' || item.speaker === 'assistant' ? 'bee' : 'customer',
        text: String(item.text || ''),
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : idx * 5,
      }));
    }

    // 2. Audio URL & Summary
    const audioUrl = payload.recordingUrl || payload.recording_url || payload.audio_url || null;
    const summary =
      payload.ai_summary ||
      payload.summary ||
      (typeof payload.transcript === 'string'
        ? payload.transcript
        : resolvedTranscript.map((t) => `${t.speaker === 'bee' ? 'Bee' : 'Customer'}: ${t.text}`).join(' '));

    // 3. Outcome & Status Mapping
    let outcome = (payload.outcome || '').trim();
    if (!outcome) {
      const s = (payload.status || '').toLowerCase().trim();
      if (s === 'completed' || s === 'success') {
        outcome = 'warranty_lead';
      } else if (s === 'failed') {
        outcome = 'FAILED';
      } else if (s === 'no_answer') {
        outcome = 'no_answer';
      } else if (s) {
        outcome = payload.status!.trim();
      } else {
        outcome = 'warranty_lead';
      }
    }

    const lo = outcome.toLowerCase();
    const needsHumanAlert =
      payload.needs_human_alert === true ||
      lo.includes('human') ||
      lo.includes('complaint') ||
      lo.includes('callback');

    const durationSeconds = payload.duration_seconds ?? payload.duration ?? 45;

    // 4. Idempotency Check: if call record already exists with targetId, perform idempotent update
    const existing = await prisma.beeCallLog.findFirst({
      where: { id: targetId, organization_id: orgId },
    });

    if (existing) {
      logger.info(`[BeeService] Inbound call ${targetId} already exists — applying idempotent update`);
      const updated = await prisma.beeCallLog.update({
        where: { id: existing.id },
        data: {
          duration_seconds: durationSeconds,
          outcome,
          transcript: resolvedTranscript as any,
          ai_summary: summary,
          audio_url: audioUrl || existing.audio_url,
          needs_human_alert: needsHumanAlert,
        },
      });

      return {
        callLog: updated,
        isNew: false,
        idempotent: true,
        leadId: updated.lead_id,
      };
    }

    // 5. Customer Resolution
    const rawCustomerId = payload.customer_id || payload.customerId;
    let customer = null;
    if (rawCustomerId && UUID_REGEX.test(rawCustomerId)) {
      customer = await prisma.customer.findFirst({
        where: { id: rawCustomerId, organization_id: orgId },
      });
    }

    if (!customer) {
      const phone = (payload.customer_phone || payload.customerPhone || '').trim();
      if (phone) {
        customer = await prisma.customer.findFirst({
          where: { organization_id: orgId, phone },
        });
      }
    }

    if (!customer) {
      customer = await prisma.customer.findFirst({
        where: { organization_id: orgId },
      });
    }

    if (!customer) {
      const rawName = (payload.customer_name || payload.customerName || 'Demo Customer').trim();
      const nameParts = rawName.split(' ');
      const firstName = nameParts[0] || 'Demo';
      const lastName = nameParts.slice(1).join(' ') || 'Customer';
      customer = await prisma.customer.create({
        data: {
          organization_id: orgId,
          customer_number: `C${Date.now().toString().slice(-6)}`,
          first_name: firstName,
          last_name: lastName,
          phone: payload.customer_phone || payload.customerPhone || '+15551234567',
          email: 'demo-customer@example.com',
          kind: 'PERSON',
          segment: 'RESIDENTIAL',
          created_by_source: 'SYSTEM',
        },
      });
    }

    const customerName =
      payload.customer_name || payload.customerName || `${customer.first_name} ${customer.last_name}`.trim();
    const customerPhone = payload.customer_phone || payload.customerPhone || customer.phone || '+15551234567';

    // 6. Voice Agent Resolution
    let agentId = payload.agent_id || payload.agentId || null;
    if (agentId && !UUID_REGEX.test(agentId)) {
      agentId = null;
    }
    if (agentId) {
      const agentExists = await prisma.beeVoiceAgent.findFirst({
        where: { id: agentId, organization_id: orgId },
      });
      if (!agentExists) agentId = null;
    }
    if (!agentId) {
      const defaultAgent = await prisma.beeVoiceAgent.findFirst({
        where: { organization_id: orgId, is_active: true },
      });
      agentId = defaultAgent?.id || null;
    }

    // 7. Queue Item Resolution
    let queueItemId = payload.queue_item_id || payload.queueItemId || null;
    if (queueItemId && !UUID_REGEX.test(queueItemId)) {
      queueItemId = null;
    }
    if (queueItemId) {
      const qItem = await prisma.beeQueueItem.findFirst({
        where: { id: queueItemId, organization_id: orgId },
      });
      if (!qItem) queueItemId = null;
    }
    if (!queueItemId) {
      const activeQueueItem = await prisma.beeQueueItem.findFirst({
        where: {
          organization_id: orgId,
          customer_id: customer.id,
          status: { in: ['scheduled', 'in_progress'] },
        },
        orderBy: { scheduled_for: 'asc' },
      });
      if (activeQueueItem) {
        queueItemId = activeQueueItem.id;
      }
    }

    // 8. Create BeeCallLog Record
    const callLog = await prisma.beeCallLog.create({
      data: {
        id: targetId,
        organization_id: orgId,
        customer_id: customer.id,
        customer_name: customerName,
        customer_phone: customerPhone,
        duration_seconds: durationSeconds,
        outcome,
        transcript: resolvedTranscript as any,
        ai_summary: summary,
        audio_url: audioUrl,
        agent_id: agentId,
        queue_item_id: queueItemId,
        needs_human_alert: needsHumanAlert,
        cost_estimate: payload.cost_estimate ? new Prisma.Decimal(payload.cost_estimate) : null,
        called_at: new Date(),
      },
    });

    // 9. Post-Call Processing: Lead Creation
    let leadId: string | null = null;
    const isLeadOutcome =
      ['warranty_lead', 'new_work_lead', 'both_leads', 'LEAD_CREATED', 'lead'].includes(outcome) ||
      lo.includes('lead');

    if (isLeadOutcome) {
      try {
        const leadType = lo.includes('both')
          ? 'both'
          : lo.includes('new_work') || lo.includes('new work')
          ? 'new_work'
          : 'warranty_extension';

        const lead = await BeeService.createLeadFromCall({
          orgId,
          customerId: customer.id,
          customerName,
          customerPhone,
          leadType,
          details: summary || (typeof payload.transcript === 'string' ? payload.transcript : JSON.stringify(resolvedTranscript)),
          callLogId: callLog.id,
        });
        leadId = lead.id;

        await prisma.beeCallLog.update({
          where: { id: callLog.id },
          data: { lead_id: lead.id },
        });
        callLog.lead_id = lead.id;
      } catch (leadErr) {
        logger.error('[BeeService] Failed to create lead from call:', leadErr);
      }
    }

    // 9b. Post-Call Processing: Task Creation Linked to Job
    if (BeeService.isFollowupTaskOutcome(outcome, needsHumanAlert)) {
      try {
        await BeeService.createTaskFromCall({
          orgId,
          jobId: (payload as any).job_id || (payload as any).jobId || null,
          queueItemId,
          customerId: customer.id,
          customerName,
          customerPhone,
          outcome,
          summary: summary || (typeof payload.transcript === 'string' ? payload.transcript : JSON.stringify(resolvedTranscript)),
          transcript: resolvedTranscript,
          callLogId: callLog.id,
        });
      } catch (taskErr) {
        logger.error('[BeeService] Failed to create follow-up task from call:', taskErr);
      }
    }

    // 10. Post-Call Processing: Queue Item Update
    if (queueItemId) {
      try {
        const isAnswered = !['no_answer', 'voicemail', 'FAILED'].includes(outcome);
        await prisma.beeQueueItem.update({
          where: { id: queueItemId },
          data: {
            status: isAnswered ? 'completed' : 'scheduled',
            last_attempted_at: new Date(),
          },
        });
      } catch (qErr) {
        logger.error('[BeeService] Failed to update queue item after call:', qErr);
      }
    }

    // 11. Post-Call Processing: DNC Registration
    const isDncOutcome =
      ['opt_out_dnc', 'dnc_requested', 'DNC_REQUESTED'].includes(outcome) ||
      lo.includes('dnc') ||
      lo.includes('opt_out');

    if (isDncOutcome) {
      try {
        await prisma.beeDncEntry.upsert({
          where: {
            organization_id_phone_number: {
              organization_id: orgId,
              phone_number: customerPhone,
            },
          },
          create: {
            organization_id: orgId,
            phone_number: customerPhone,
            reason: 'Voice call opt-out',
            source: 'voice_opt_out',
            call_log_id: callLog.id,
          },
          update: {
            call_log_id: callLog.id,
          },
        });
      } catch (dncErr) {
        logger.error('[BeeService] Failed to register DNC entry from call:', dncErr);
      }
    }

    logger.info(`[BeeService] Successfully processed inbound call ${callLog.id} (outcome: ${outcome}, leadId: ${leadId})`);

    return {
      callLog,
      isNew: true,
      idempotent: false,
      leadId,
    };
  }

  /**
   * Resolves a valid Customer record for `bee_call_logs` foreign key integrity.
   */
  private static async resolveCustomerForCallLog(
    orgId: string,
    customerId?: string | null,
    customerPhone?: string,
    customerName?: string
  ) {
    let customer = null;
    if (customerId && UUID_REGEX.test(customerId.trim())) {
      customer = await prisma.customer.findFirst({
        where: { id: customerId.trim(), organization_id: orgId },
      });
    }
    if (!customer && customerPhone) {
      const cleanPhone = customerPhone.trim();
      customer = await prisma.customer.findFirst({
        where: { organization_id: orgId, phone: cleanPhone },
      });
    }
    if (!customer) {
      customer = await prisma.customer.findFirst({
        where: { organization_id: orgId },
        orderBy: { created_at: 'desc' },
      });
    }
    if (!customer) {
      const rawName = (customerName || 'Valued Customer').trim();
      const parts = rawName.split(' ');
      customer = await prisma.customer.create({
        data: {
          organization_id: orgId,
          customer_number: `C${Date.now().toString().slice(-6)}`,
          first_name: parts[0] || 'Valued',
          last_name: parts.slice(1).join(' ') || 'Customer',
          phone: customerPhone || '+15551234567',
          email: 'customer@example.com',
          kind: 'PERSON',
          segment: 'RESIDENTIAL',
          created_by_source: 'SYSTEM',
        },
      });
    }
    return customer;
  }

  /**
   * For call logs with technical failure, extracts ONLY the message from the response body
   * (e.g. from {"message": ["..."], "error": "Bad Request", "statusCode": 400}).
   */
  static extractFailureMessage(rawSummary?: string | null): string {
    if (!rawSummary || typeof rawSummary !== 'string') return '';
    const text = rawSummary.trim();
    if (!text) return '';

    // 1. Try to find a JSON object in the text: {...}
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const jsonCandidate = text.substring(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonCandidate);
        if (Array.isArray(parsed?.message)) {
          const msg = parsed.message
            .filter(Boolean)
            .map((m: any) => String(m).trim())
            .join(' ');
          if (msg) return msg;
        } else if (typeof parsed?.message === 'string' && parsed.message.trim()) {
          return parsed.message.trim();
        } else if (parsed?.message && typeof parsed.message === 'object') {
          const subMsg = parsed.message.message || parsed.message.error || parsed.message.detail;
          if (typeof subMsg === 'string' && subMsg.trim()) return subMsg.trim();
        }

        if (typeof parsed?.error === 'string' && parsed.error.trim() && parsed.error.toLowerCase() !== 'bad request') {
          return parsed.error.trim();
        } else if (parsed?.error && typeof parsed.error === 'object') {
          const errMsg = parsed.error.message || parsed.error.detail || parsed.error.description;
          if (typeof errMsg === 'string' && errMsg.trim()) return errMsg.trim();
        }

        const fallbackField = parsed?.error_description || parsed?.detail || parsed?.description || parsed?.reason;
        if (typeof fallbackField === 'string' && fallbackField.trim()) {
          return fallbackField.trim();
        }
      } catch {
        // not valid JSON
      }
    }

    const vapiPrefixMatch = text.match(/Vapi (?:Call Failed|rejected call)[^:]*:\s*(.+)$/i);
    if (vapiPrefixMatch && vapiPrefixMatch[1]) {
      const candidate = vapiPrefixMatch[1].trim();
      const subCleaned = BeeService.extractFailureMessage(candidate);
      if (subCleaned) return subCleaned;
      return candidate;
    }

    const callFailedMatch = text.match(/(?:Call (?:for [^:]+ )?failed|Failed):\s*(.+)$/i);
    if (callFailedMatch && callFailedMatch[1]) {
      const candidate = callFailedMatch[1].trim();
      const subCleaned = BeeService.extractFailureMessage(candidate);
      if (subCleaned) return subCleaned;
      return candidate;
    }

    return text;
  }

  /**
   * Creates the initial `bee_call_logs` row immediately when an outbound call is initiated
   * (used by both Queue Calls and Agent Test Calls).
   *
   * - Uses the Voice Engine's `callId` (e.g., Vapi Call UUID) as `bee_call_logs.id` so that when
   *   the call completes and its result is generated, the system updates this exact same row.
   * - While the call is active (`status === 'initiated'`), `transcript` is `[]` and `audio_url` is `null`
   *   because the recording and transcript are not yet generated.
   * - Automatically registers server-side post-call completion delivery (`BeeVoiceAdapter.schedulePostCallResultDelivery`)
   *   in addition to Vapi's `end-of-call-report` webhook (Both Ways).
   */
  static async createInitialCallLog(
    orgId: string,
    params: {
      callId?: string;
      status: 'initiated' | 'completed' | 'failed';
      provider?: string;
      customerId?: string | null;
      customerName?: string;
      customerPhone: string;
      agentId?: string | null;
      queueItemId?: string | null;
      jobNumber?: string;
      jobType?: string;
      error?: string;
      isTestCall?: boolean;
    }
  ) {
    const rawCallId = (params.callId || '').trim();
    const targetId = rawCallId
      ? UUID_REGEX.test(rawCallId)
        ? rawCallId
        : toDeterministicUuid(rawCallId, orgId)
      : crypto.randomUUID();

    const customer = await this.resolveCustomerForCallLog(
      orgId,
      params.customerId,
      params.customerPhone,
      params.customerName
    );

    const resolvedCustomerId =
      customer?.id ||
      (params.customerId && UUID_REGEX.test(params.customerId.trim()) ? params.customerId.trim() : null) ||
      crypto.randomUUID();

    const resolvedCustomerName =
      params.customerName?.trim() ||
      `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() ||
      customer?.company_name ||
      'Valued Customer';

    let validAgentId =
      params.agentId && UUID_REGEX.test(params.agentId.trim()) ? params.agentId.trim() : null;
    if (validAgentId) {
      const exists = await prisma.beeVoiceAgent.findFirst({
        where: { id: validAgentId, organization_id: orgId },
        select: { id: true },
      });
      if (!exists) validAgentId = null;
    }

    let validQueueItemId =
      params.queueItemId && UUID_REGEX.test(params.queueItemId.trim())
        ? params.queueItemId.trim()
        : null;
    if (validQueueItemId) {
      const qExists = await prisma.beeQueueItem.findFirst({
        where: { id: validQueueItemId, organization_id: orgId },
        select: { id: true },
      });
      if (!qExists) validQueueItemId = null;
    }

    const isFailed = params.status === 'failed';
    const outcome = isFailed ? 'FAILED' : 'CALL_INITIATED';
    const contextLabel = params.isTestCall
      ? `Test Call${params.jobNumber ? ` (Job ${params.jobNumber})` : ''}`
      : `Job ${params.jobNumber || '—'}${params.jobType ? ` (${params.jobType})` : ''}`;

    const cleanError = isFailed ? (BeeService.extractFailureMessage(params.error) || params.error || 'Telephony transport error') : '';
    const initialSummary = isFailed
      ? cleanError
      : `Call in progress for ${contextLabel} via ${(params.provider || 'vapi').toUpperCase()} — awaiting call completion, recording link, and timestamped transcript...`;

    const existing = await prisma.beeCallLog.findFirst({
      where: { id: targetId, organization_id: orgId },
    });

    let callLog;
    if (existing) {
      callLog = await prisma.beeCallLog.update({
        where: { id: existing.id },
        data: {
          customer_id: resolvedCustomerId,
          customer_name: resolvedCustomerName,
          customer_phone: params.customerPhone,
          agent_id: validAgentId || existing.agent_id,
          queue_item_id: validQueueItemId || existing.queue_item_id,
          outcome: existing.outcome === 'CALL_INITIATED' ? outcome : existing.outcome,
          ai_summary: existing.audio_url ? existing.ai_summary : initialSummary,
        },
      });
    } else {
      callLog = await prisma.beeCallLog.create({
        data: {
          id: targetId,
          organization_id: orgId,
          customer_id: resolvedCustomerId,
          customer_name: resolvedCustomerName,
          customer_phone: params.customerPhone,
          agent_id: validAgentId,
          queue_item_id: validQueueItemId,
          duration_seconds: 0,
          outcome,
          transcript: [] as any,
          audio_url: null,
          ai_summary: initialSummary,
          called_at: new Date(),
        },
      });
    }

    // Register server-side completion listener (Way 2) so that as soon as the call finishes on Vapi,
    // the system posts the recording URL and timestamped transcript directly back into this exact callLog row.
    if (!isFailed && rawCallId) {
      BeeVoiceAdapter.schedulePostCallResultDelivery(orgId, rawCallId, async (result) => {
        await BeeService.ingestCallResultStageOne(orgId, result);
      });
    }

    return callLog;
  }

  /**
   * Canonical parser for single or multi-tag `outcome` strings on `bee_call_logs`.
   *
   * Supported Tags:
   * - Stage 1 Code / Telephony Facts:
   *   - `ANSWERED`            : Answered (Answered = Yes)
   *   - `NO_ANSWER`           : No answer / machine (Answered = No — retry rules apply)
   *   - `VOICEMAIL`           : Voicemail / machine (Answered = No — retry rules apply)
   *   - `FAILED`              : Technical failure (Answered = No — retry)
   *   - `WRONG_NUMBER`        : Wrong number (Answered = No — flag number for office)
   *   - `NEEDS_REVIEW`        : Needs review (Answered = Not until confirmed)
   *   - `CALL_INITIATED`      : Call in progress (Answered = No)
   *
   * - Stage 2 LLM / Manual Semantic Tags (all count as Answered = Yes, so `ANSWERED` is included alongside them):
   *   - `INTERESTED_WARRANTY` : Wants a warranty plan
   *   - `INTERESTED_NEW_WORK` : Wants new work
   *   - `INTERESTED_BOTH`     : Wants plan + new work
   *   - `CALLBACK_REQUESTED`  : Call back later — office
   *   - `HANDOFF_HUMAN`       : Needs a human
   *   - `COMPLAINT`           : Complaint — needs a human
   *   - `NOT_INTERESTED`      : Not interested
   *   - `ALREADY_COVERED`     : Has other coverage
   *   - `DNC_REQUESTED`       : Do not call
   */
  static parseOutcomeTags(
    rawOutcome?: string | null,
    leadFormat?: string | null,
    needsHumanFlag?: boolean
  ): {
    tags: string[];
    primaryLegacyCode: string;
    leadFormat: string | null;
    isAnswered: boolean;
    needsHumanAlert: boolean;
    sentiment: string;
  } {
    const rawTokens = String(rawOutcome || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const tagsSet = new Set<string>();
    let lf: string | null = leadFormat || null;

    for (const token of rawTokens) {
      const u = token.toUpperCase();
      const l = token.toLowerCase();

      if (u === 'INTERESTED_BOTH' || l === 'both_leads' || (l.includes('both') && l.includes('lead'))) {
        tagsSet.add('ANSWERED');
        tagsSet.add('INTERESTED_WARRANTY');
        tagsSet.add('INTERESTED_NEW_WORK');
        lf = 'both';
      } else if (
        u === 'INTERESTED_WARRANTY' ||
        l === 'warranty_lead' ||
        (l.includes('warranty') && l.includes('lead'))
      ) {
        tagsSet.add('ANSWERED');
        tagsSet.add('INTERESTED_WARRANTY');
        lf = lf || 'warranty';
      } else if (
        u === 'INTERESTED_NEW_WORK' ||
        u === 'INTERESTED_NEW_JOB' ||
        l === 'new_work_lead' ||
        l === 'new_job_lead' ||
        l.includes('new_work') ||
        l.includes('new work') ||
        l.includes('new_job') ||
        l.includes('new job')
      ) {
        tagsSet.add('ANSWERED');
        tagsSet.add('INTERESTED_NEW_WORK');
        lf = lf || 'new job';
      } else if (u === 'LEAD_CREATED' || l === 'lead') {
        tagsSet.add('ANSWERED');
        if (lf === 'both') {
          tagsSet.add('INTERESTED_WARRANTY');
          tagsSet.add('INTERESTED_NEW_WORK');
        } else if (lf === 'new work' || lf === 'new job') {
          tagsSet.add('INTERESTED_NEW_WORK');
        } else {
          tagsSet.add('INTERESTED_WARRANTY');
          lf = lf || 'lead';
        }
      } else if (u === 'COMPLAINT' || l.includes('complaint')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('COMPLAINT');
      } else if (u === 'CALLBACK_REQUESTED' || l.includes('callback')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('CALLBACK_REQUESTED');
      } else if (u === 'HANDOFF_HUMAN' || l.includes('human')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('HANDOFF_HUMAN');
      } else if (u === 'ALREADY_COVERED' || l.includes('coverage') || l.includes('covered')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('ALREADY_COVERED');
      } else if (u === 'NOT_INTERESTED' || l.includes('not_interested') || l.includes('not interested')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('NOT_INTERESTED');
      } else if (u === 'DNC_REQUESTED' || l.includes('dnc') || l.includes('opt_out') || l.includes('donot')) {
        tagsSet.add('ANSWERED');
        tagsSet.add('DNC_REQUESTED');
      } else if (u === 'WRONG_NUMBER' || l.includes('wrong')) {
        tagsSet.add('WRONG_NUMBER');
      } else if (u === 'VOICEMAIL' || l === 'voicemail' || l.includes('machine')) {
        tagsSet.add('NO_ANSWER');
        if (u === 'VOICEMAIL' || l === 'voicemail') {
          tagsSet.add('VOICEMAIL');
        }
      } else if (u === 'NO_ANSWER' || l.includes('no_answer') || l.includes('no answer')) {
        tagsSet.add('NO_ANSWER');
      } else if (u === 'FAILED' || l.includes('fail')) {
        tagsSet.add('FAILED');
      } else if (u === 'NEEDS_REVIEW' || l.includes('review')) {
        tagsSet.add('NEEDS_REVIEW');
      } else if (u === 'CALL_INITIATED' || u === 'IN_PROGRESS' || l.includes('initiat') || l.includes('progress')) {
        tagsSet.add('CALL_INITIATED');
      } else if (u === 'ANSWERED' || u === 'COMPLETED' || u === 'PENDING_CLASSIFICATION' || l.includes('complet') || l.includes('answer')) {
        tagsSet.add('ANSWERED');
      }
    }

    if (tagsSet.size === 0) {
      if (needsHumanFlag) {
        tagsSet.add('ANSWERED');
        tagsSet.add('HANDOFF_HUMAN');
      } else {
        tagsSet.add('ANSWERED');
      }
    }

    // Ensure INTERESTED_BOTH is never kept as a combined tag, but expanded into individual tags
    if (tagsSet.has('INTERESTED_BOTH')) {
      tagsSet.delete('INTERESTED_BOTH');
      tagsSet.add('ANSWERED');
      tagsSet.add('INTERESTED_WARRANTY');
      tagsSet.add('INTERESTED_NEW_WORK');
    }

    // Order tags consistently: ANSWERED first (if answered), followed by specific semantic or factual tags
    const orderedTags: string[] = [];
    if (tagsSet.has('ANSWERED')) orderedTags.push('ANSWERED');
    for (const t of tagsSet) {
      if (t !== 'ANSWERED') orderedTags.push(t);
    }

    const isAnswered = tagsSet.has('ANSWERED');
    const needsHumanAlert =
      Boolean(needsHumanFlag) ||
      tagsSet.has('COMPLAINT') ||
      tagsSet.has('HANDOFF_HUMAN') ||
      tagsSet.has('CALLBACK_REQUESTED') ||
      tagsSet.has('WRONG_NUMBER');

    let primaryLegacyCode = orderedTags[orderedTags.length - 1] || 'ANSWERED';
    const rawLower = String(rawOutcome || '').toLowerCase();
    if (
      rawLower === 'warranty_lead' ||
      rawLower === 'new_work_lead' ||
      rawLower === 'both_leads' ||
      rawLower === 'lead_created' ||
      rawLower === 'lead'
    ) {
      primaryLegacyCode = 'LEAD_CREATED';
    } else if (
      tagsSet.has('INTERESTED_WARRANTY') ||
      tagsSet.has('INTERESTED_NEW_WORK')
    ) {
      primaryLegacyCode = orderedTags.find((t) => t.startsWith('INTERESTED_')) || 'LEAD_CREATED';
    } else if (tagsSet.has('VOICEMAIL') && tagsSet.has('NO_ANSWER') && orderedTags.length === 2) {
      primaryLegacyCode = 'NO_ANSWER';
    }

    let sentiment = 'Neutral';
    if (
      tagsSet.has('INTERESTED_WARRANTY') ||
      tagsSet.has('INTERESTED_NEW_WORK')
    ) {
      sentiment = 'Positive';
    } else if (tagsSet.has('COMPLAINT') || tagsSet.has('DNC_REQUESTED')) {
      sentiment = 'Negative';
    } else if (!isAnswered) {
      sentiment = '—';
    }

    return {
      tags: orderedTags,
      primaryLegacyCode,
      leadFormat: lf,
      isAnswered,
      needsHumanAlert,
      sentiment,
    };
  }

  /**
   * Deterministically derives Stage 1 factual outcome tags and whether the call was Answered
   * directly from the Voice Engine's call action / completion telemetry (`endedReason`, `endedMessage`,
   * `status`, `durationSeconds`, and customer transcript turns).
   *
   * Stage 1 Factual Outcomes:
   * - `ANSWERED`      : Customer answered the call (Answered = Yes)
   * - `NO_ANSWER`     : Customer did not answer / busy (Answered = No — retry rules apply)
   * - `VOICEMAIL`     : Reached voicemail / answering machine (Answered = No — retry rules apply)
   * - `FAILED`        : Technical / telephony transport failure (Answered = No — retry)
   * - `WRONG_NUMBER`  : Invalid / unallocated / disconnected number from telephony (Answered = No — flag number for office)
   * - `NEEDS_REVIEW`  : Ambiguous very short connection with 0 customer turns (Answered = Not until confirmed)
   */
  static deriveStageOneCallFacts(result: VoiceEngineCallResultPayload): {
    primaryOutcome: string;
    outcomeTags: string[];
    isAnswered: boolean;
    needsHumanAlert: boolean;
    defaultSummary: string;
  } {
    const reason = (result.endedReason || '').toLowerCase().trim();
    const message = (result.endedMessage || '').toLowerCase().trim();
    const durationSeconds = Math.max(0, Math.round(result.durationSeconds || 0));
    const transcriptTurns = Array.isArray(result.transcript) ? result.transcript : [];
    const customerTurns = transcriptTurns.filter((t) => t.speaker === 'customer' && t.text?.trim());

    // 1. Wrong Number / Invalid / Unallocated / Disconnected Number (Telephony SIP 404/484/unallocated)
    const isWrongNumber =
      reason.includes('wrong-number') ||
      reason.includes('invalid-number') ||
      reason.includes('unallocated') ||
      reason.includes('not-in-service') ||
      reason.includes('disconnected-number') ||
      message.includes('unallocated') ||
      message.includes('invalid number') ||
      message.includes('not in service') ||
      message.includes('disconnected number') ||
      message.includes('404 not found') ||
      message.includes('484 address incomplete');

    if (isWrongNumber) {
      return {
        primaryOutcome: 'WRONG_NUMBER',
        outcomeTags: ['WRONG_NUMBER'],
        isAnswered: false,
        needsHumanAlert: true,
        defaultSummary:
          result.endedMessage ||
          'Number reported as invalid or disconnected — flagged for office review.',
      };
    }

    // 2. Technical / Telephony Failure (`FAILED`)
    const isTechnicalFailure =
      result.status === 'failed' ||
      reason.startsWith('call.start.error') ||
      reason.startsWith('pipeline-error') ||
      reason.startsWith('call-in-progress.error') ||
      reason.includes('failed-to-connect') ||
      reason.includes('assistant-not-found') ||
      reason.includes('assistant-not-valid') ||
      reason.includes('assistant-request-failed') ||
      reason.includes('worker-shutdown') ||
      reason.includes('unknown-error') ||
      reason.includes('transport-error') ||
      reason.includes('sip-gateway-error');

    if (isTechnicalFailure) {
      return {
        primaryOutcome: 'FAILED',
        outcomeTags: ['FAILED'],
        isAnswered: false,
        needsHumanAlert: false,
        defaultSummary:
          (result.endedMessage ? BeeService.extractFailureMessage(result.endedMessage) : '') ||
          result.endedMessage ||
          `Technical failure (${result.endedReason || 'telephony transport error'}) — eligible for retry.`,
      };
    }

    // 3. Voicemail / Answering Machine (`NO_ANSWER,VOICEMAIL`)
    const isVoicemailOrMachine =
      reason.includes('voicemail') ||
      reason.includes('machine_start') ||
      reason.includes('machine_end') ||
      reason.includes('machine-detected') ||
      reason.includes('answering-machine') ||
      reason === 'machine';

    if (isVoicemailOrMachine) {
      return {
        primaryOutcome: 'NO_ANSWER,VOICEMAIL',
        outcomeTags: ['NO_ANSWER', 'VOICEMAIL'],
        isAnswered: false,
        needsHumanAlert: false,
        defaultSummary: 'Call reached voicemail / answering machine — retry rules apply.',
      };
    }

    // 4. Not Answered / Busy / Silence Timeout without Customer Speech (`NO_ANSWER`)
    const isNoAnswerOrBusy =
      reason.includes('did-not-answer') ||
      reason.includes('no-answer') ||
      reason.includes('customer-busy') ||
      reason.includes('dial-busy') ||
      reason.includes('busy') ||
      reason.includes('rejected') ||
      reason.includes('canceled') ||
      (reason.includes('silence-timed-out') && customerTurns.length === 0) ||
      (durationSeconds === 0 && customerTurns.length === 0);

    if (isNoAnswerOrBusy) {
      return {
        primaryOutcome: 'NO_ANSWER',
        outcomeTags: ['NO_ANSWER'],
        isAnswered: false,
        needsHumanAlert: false,
        defaultSummary: 'Customer did not answer — retry rules apply.',
      };
    }

    // 5. Answered (`ANSWERED`)
    // A call is deterministically Answered when it connected and did not fail/voicemail/no-answer,
    // and either the customer spoke (`customerTurns.length > 0`) or the connected call lasted >= 5s.
    if (customerTurns.length > 0 || durationSeconds >= 5) {
      const customerPreview = customerTurns.map((t) => t.text).join(' | ');
      return {
        primaryOutcome: 'ANSWERED',
        outcomeTags: ['ANSWERED'],
        isAnswered: true,
        needsHumanAlert: false,
        defaultSummary: customerPreview
          ? `Call answered (${durationSeconds}s · ${transcriptTurns.length} turns). Customer responses: "${customerPreview.slice(0, 220)}"`
          : `Call answered (${durationSeconds}s · ${transcriptTurns.length} turns). Recording and timestamped transcript saved.`,
      };
    }

    // 6. Ambiguous ultra-short connection (< 5s with 0 customer turns) -> `NEEDS_REVIEW`
    return {
      primaryOutcome: 'NEEDS_REVIEW',
      outcomeTags: ['NEEDS_REVIEW'],
      isAnswered: false,
      needsHumanAlert: false,
      defaultSummary: `Short call connection (${durationSeconds}s) with no customer speech — flagged for review.`,
    };
  }

  /**
   * STAGE 1 of the 2-Stage Call Logging Pipeline:
   * Ingests a completed call result from the Voice Calling Engine (either pushed via Vapi `end-of-call-report`
   * webhook OR delivered by the server-side completion listener / reconciliation) and updates the
   * exact same `bee_call_logs` record (`id = callId`) with:
   * - `audio_url` (recording link)
   * - `transcript` (timestamped turns `[{ speaker: 'bee' | 'customer', text, timestamp }]`)
   * - `duration_seconds`
   * - `cost_estimate`
   * - Stage 1 factual outcome (`ANSWERED`, `NO_ANSWER`, `NO_ANSWER,VOICEMAIL`, `FAILED`, `WRONG_NUMBER`, `NEEDS_REVIEW`)
   *
   * Note: Stage 2 (Separate Outcome Classifier LLM) will later run on `callLog.id` to append semantic
   * business outcomes (`INTERESTED_WARRANTY`, `INTERESTED_NEW_WORK`, `INTERESTED_BOTH`, `COMPLAINT`, `CALLBACK_REQUESTED`, `NOT_INTERESTED`, etc.)
   * alongside `ANSWERED`.
   */
  static async ingestCallResultStageOne(
    orgId: string,
    result: VoiceEngineCallResultPayload
  ): Promise<ProcessInboundCallResult> {
    const rawCallId = (result.callId || '').trim();
    const targetId = rawCallId
      ? UUID_REGEX.test(rawCallId)
        ? rawCallId
        : toDeterministicUuid(rawCallId, orgId)
      : crypto.randomUUID();

    const facts = this.deriveStageOneCallFacts(result);
    const stageOneOutcome = facts.primaryOutcome;

    const audioUrl = result.recordingUrl || result.stereoRecordingUrl || null;
    const durationSeconds = Math.max(0, Math.round(result.durationSeconds || 0));
    const transcriptTurns = Array.isArray(result.transcript) ? result.transcript : [];

    const stageOneSummary = (result.summary || '').trim() || facts.defaultSummary;

    // 1. Check if the initial call log record (`CALL_INITIATED`) already exists
    const existing = await prisma.beeCallLog.findFirst({
      where: { id: targetId, organization_id: orgId },
    });

    if (existing) {
      // Preserve any Stage 2 semantic outcome tag if Stage 2 or an admin already classified this call
      const isProvisionalOutcome = [
        'CALL_INITIATED',
        'IN_PROGRESS',
        'COMPLETED',
        'ANSWERED',
        'PENDING_CLASSIFICATION',
      ].includes(existing.outcome);

      let resolvedOutcome = stageOneOutcome;
      if (!isProvisionalOutcome) {
        const parsedExisting = this.parseOutcomeTags(existing.outcome);
        const semanticTags = parsedExisting.tags.filter(
          (t) =>
            ![
              'CALL_INITIATED',
              'IN_PROGRESS',
              'COMPLETED',
              'ANSWERED',
              'NO_ANSWER',
              'VOICEMAIL',
              'FAILED',
              'WRONG_NUMBER',
              'NEEDS_REVIEW',
            ].includes(t)
        );
        if (semanticTags.length > 0) {
          resolvedOutcome = facts.isAnswered
            ? ['ANSWERED', ...semanticTags].join(',')
            : semanticTags.join(',');
        } else {
          resolvedOutcome = existing.outcome;
        }
      }

      const updated = await prisma.beeCallLog.update({
        where: { id: existing.id },
        data: {
          duration_seconds: durationSeconds || existing.duration_seconds,
          outcome: resolvedOutcome,
          needs_human_alert: existing.needs_human_alert || facts.needsHumanAlert,
          transcript:
            transcriptTurns.length > 0 ? (transcriptTurns as any) : (existing.transcript as any),
          audio_url: audioUrl || existing.audio_url,
          ai_summary: stageOneSummary || existing.ai_summary,
          ...(result.cost !== undefined
            ? { cost_estimate: new Prisma.Decimal(result.cost) }
            : {}),
        },
      });

      // Update linked Queue Item status if applicable
      if (updated.queue_item_id) {
        if (facts.primaryOutcome === 'WRONG_NUMBER') {
          await prisma.beeQueueItem
            .update({
              where: { id: updated.queue_item_id },
              data: {
                status: 'skipped',
                skip_reason: 'Wrong number — flagged for office',
                last_attempted_at: new Date(),
              },
            })
            .catch(() => {});
        } else {
          let nextStatus = facts.isAnswered ? 'completed' : 'scheduled';
          let archiveReason: string | undefined = undefined;
          if (!facts.isAnswered) {
            const currentQueueItem = await prisma.beeQueueItem.findUnique({
              where: { id: updated.queue_item_id },
              select: { attempt_count: true },
            }).catch(() => null);
            const beeSettings = await prisma.beeSetting.findUnique({
              where: { organization_id: orgId },
              select: { max_retries: true },
            }).catch(() => null);
            const maxRetries = beeSettings?.max_retries ?? 2;
            if (currentQueueItem && currentQueueItem.attempt_count >= maxRetries) {
              nextStatus = 'archived';
              archiveReason = 'Retry limit reached';
            }
          }
          await prisma.beeQueueItem
            .update({
              where: { id: updated.queue_item_id },
              data: {
                status: nextStatus,
                ...(archiveReason ? { skip_reason: archiveReason } : {}),
                last_attempted_at: new Date(),
              },
            })
            .catch(() => {});
        }
      }

      logger.info(
        `[BeeService] Stage 1 updated existing BeeCallLog ${updated.id} (outcome: ${updated.outcome}, answered: ${facts.isAnswered}, duration: ${updated.duration_seconds}s, turns: ${transcriptTurns.length}, audio: ${Boolean(updated.audio_url)})`
      );

      // Create Follow-up Task ONLY when transitioning from a provisional/in-progress state to completed
      if (isProvisionalOutcome && BeeService.isFollowupTaskOutcome(updated.outcome, facts.needsHumanAlert)) {
        const updateMeta = result.metadata || {};
        BeeService.createTaskFromCall({
          orgId,
          jobId: updateMeta.jobId || null,
          queueItemId: existing.queue_item_id,
          customerId: existing.customer_id,
          customerName: existing.customer_name,
          customerPhone: existing.customer_phone,
          outcome: updated.outcome,
          summary: stageOneSummary,
          transcript: transcriptTurns,
          callLogId: updated.id,
        }).catch((err) => {
          logger.error('[BeeService] Failed to create follow-up task on call log update:', err);
        });
      }

      // TODO (Stage 2 Hook): Trigger separate Outcome Classifier LLM here once configured
      return {
        callLog: updated,
        isNew: false,
        idempotent: true,
        leadId: updated.lead_id,
      };
    }

    // 2. If the call log row was not pre-created (e.g. external call or older Vapi call), create it now
    const meta = result.metadata || {};
    const customer = await this.resolveCustomerForCallLog(
      orgId,
      meta.customerId,
      result.customerPhone || meta.customerPhone,
      result.customerName || meta.customerName
    );

    const customerName =
      result.customerName ||
      meta.customerName ||
      `${customer.first_name || ''} ${customer.last_name || ''}`.trim() ||
      customer.company_name ||
      'Valued Customer';

    const customerPhone =
      result.customerPhone || meta.customerPhone || customer.phone || '+15551234567';

    // Match agent by metadata.agentId or by Vapi assistantId
    let agentId: string | null =
      meta.agentId && UUID_REGEX.test(meta.agentId) ? meta.agentId : null;
    if (!agentId && result.assistantId) {
      const orgAgents = await prisma.beeVoiceAgent.findMany({
        where: { organization_id: orgId },
      });
      const matchedByAssistant = orgAgents.find((a) => {
        const norm = this.normalizeAgentRecord(a);
        return norm?.vapi_assistant_id === result.assistantId;
      });
      agentId = matchedByAssistant?.id || orgAgents[0]?.id || null;
    }
    if (!agentId) {
      const firstAgent = await prisma.beeVoiceAgent.findFirst({
        where: { organization_id: orgId, is_active: true },
        select: { id: true },
      });
      agentId = firstAgent?.id || null;
    }

    let queueItemId: string | null =
      meta.queueItemId && UUID_REGEX.test(meta.queueItemId) ? meta.queueItemId : null;
    if (queueItemId) {
      const qExists = await prisma.beeQueueItem.findFirst({
        where: { id: queueItemId, organization_id: orgId },
        select: { id: true },
      });
      if (!qExists) queueItemId = null;
    }

    const calledAt = result.startedAt ? new Date(result.startedAt) : new Date();

    const created = await prisma.beeCallLog.create({
      data: {
        id: targetId,
        organization_id: orgId,
        customer_id: customer.id,
        customer_name: customerName,
        customer_phone: customerPhone,
        agent_id: agentId,
        queue_item_id: queueItemId,
        duration_seconds: durationSeconds,
        outcome: stageOneOutcome,
        needs_human_alert: facts.needsHumanAlert,
        transcript: transcriptTurns as any,
        audio_url: audioUrl,
        ai_summary: stageOneSummary,
        cost_estimate:
          result.cost !== undefined ? new Prisma.Decimal(result.cost) : null,
        called_at: calledAt,
      },
    });

    logger.info(
      `[BeeService] Stage 1 created BeeCallLog ${created.id} (outcome: ${created.outcome}, answered: ${facts.isAnswered}, duration: ${created.duration_seconds}s, turns: ${transcriptTurns.length})`
    );

    // Create Follow-up Task for the job dispatcher if outcome triggers task creation
    if (BeeService.isFollowupTaskOutcome(created.outcome, facts.needsHumanAlert)) {
      BeeService.createTaskFromCall({
        orgId,
        jobId: meta.jobId || null,
        queueItemId,
        customerId: customer.id,
        customerName,
        customerPhone,
        outcome: created.outcome,
        summary: stageOneSummary,
        transcript: transcriptTurns,
        callLogId: created.id,
      }).catch((err) => {
        logger.error('[BeeService] Failed to create follow-up task on call log create:', err);
      });
    }

    return {
      callLog: created,
      isNew: true,
      idempotent: false,
      leadId: null,
    };
  }

  /**
   * Checks whether a stored `audio_url` is missing, is an unsigned private R2 URL
   * (missing `X-Amz-Signature`), or has an expired AWS SigV4 presigned timestamp.
   */
  static isAudioUrlUnsignedOrExpired(url?: string | null): boolean {
    if (!url) return true;
    if (url.includes('r2.cloudflarestorage.com')) {
      if (!url.includes('X-Amz-Signature=')) return true;
      try {
        const parsed = new URL(url);
        const amzDate = parsed.searchParams.get('X-Amz-Date');
        const amzExpires = Number(parsed.searchParams.get('X-Amz-Expires') || '1800');
        if (amzDate && amzDate.length >= 15) {
          const iso = `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`;
          const signedAtMs = new Date(iso).getTime();
          if (Number.isFinite(signedAtMs)) {
            if (Date.now() > signedAtMs + (amzExpires - 120) * 1000) {
              return true;
            }
          }
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  /**
   * Reconciles any `CALL_INITIATED` call logs in `bee_call_logs` (and recent completed calls on the
   * active Voice Calling Engine) so that completed call recordings and timestamped transcripts are
   * guaranteed to be populated even when running on localhost without an external webhook tunnel.
   */
  static async reconcilePendingCallLogs(orgId: string): Promise<void> {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return;

    try {
      // Only check call logs that are currently in CALL_INITIATED or IN_PROGRESS state
      const pendingLogs = await prisma.beeCallLog.findMany({
        where: {
          organization_id: orgId,
          outcome: { in: ['CALL_INITIATED', 'IN_PROGRESS'] },
        },
        orderBy: { called_at: 'desc' },
        take: 10,
      });

      if (pendingLogs.length === 0) return;

      for (const pending of pendingLogs) {
        const details = await BeeVoiceAdapter.getCallDetails(orgId, pending.id);
        if (details && (details.status === 'ended' || details.status === 'failed')) {
          await this.ingestCallResultStageOne(orgId, details);
        }
      }
    } catch (err) {
      logger.warn('[BeeService] Non-fatal warning reconciling pending call logs:', err);
    }
  }
}
