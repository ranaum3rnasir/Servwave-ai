/**
 * spiderDispatch.service.ts — Dispatches Email, SMS, and In-App alerts for Spider AI Agent
 *
 * Resolves recipients based on Spider Agent assignment configuration (Admin Roles, Specific Users, Lead Owner)
 * and dispatches notifications across the enabled channels (Email, SMS, In-App).
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { sendAutomationEmail, esc } from '../../lib/email';
import { sendStaffAlertSms } from '../../lib/ctm/sendSms';
import { emit } from './notificationService';
import { loadRoleHolders } from './roleHolders';
import { resolveSpiderAlertRecipients, getSpiderLeadOwnerId } from './spiderAlerts';

export interface SpiderDispatchAssignments {
  adminRoles?: string[];
  users?: string[];
  owner?: boolean;
}

export function mapSmsDeliveryFailureReason(reason?: string): string {
  if (!reason) return 'Text message could not be delivered';
  switch (reason) {
    case 'NOT_CONNECTED':
      return 'SMS service is not connected';
    case 'SMS_NOT_READY':
      return 'SMS messaging is not ready';
    case 'ORG_SMS_DISABLED':
      return 'SMS messaging is disabled';
    case 'NOT_ENTITLED':
      return 'SMS messaging is not entitled';
    case 'NO_SMS_NUMBER':
      return 'No phone number configured';
    case 'NOT_IN_TEST_ALLOWLIST':
      return 'Phone number not in allowlist';
    case 'RECIPIENT_OPTED_OUT':
      return 'Recipient opted out';
    case 'DUPLICATE_SEND':
      return 'Duplicate notification prevented';
    case 'CTM_ERROR':
    default:
      return 'Text message delivery failed';
  }
}

export function mapEmailDeliveryFailureReason(reason?: string): string {
  if (!reason) return 'Email delivery failed';
  if (reason.toLowerCase().includes('opted') || reason.toLowerCase().includes('suppress')) return 'Recipient opted out';
  return 'Email delivery failed';
}

export interface SpiderDispatchNotificationsConfig {
  email?: boolean;
  sms?: boolean;
  inApp?: boolean;
  redFrame?: boolean;
}

export interface DispatchSpiderAlertParams {
  organizationId: string;
  leadId: string;
  stageLabel?: string;
  elapsedValue?: number;
  elapsedUnit?: string;
  elapsedSeconds?: number;
  assignments: SpiderDispatchAssignments;
  notifications: SpiderDispatchNotificationsConfig;
  actorId?: string | null;
  appBaseUrl?: string;
  dedupeKey?: string | null;
}

export interface DispatchSpiderAlertResult {
  ok: boolean;
  recipientCount: number;
  emailsSent: number;
  emailsSkipped: number;
  emailsFailed: number;
  smsSent: number;
  smsSkipped: number;
  smsFailed: number;
  inAppEmitted: boolean;
  alreadyAlerted?: boolean;
  error?: string;
}

export function normalizeSpiderStageName(stageLabelOrId?: string): string {
  if (!stageLabelOrId) return 'New';
  const s = stageLabelOrId.trim();
  const lower = s.toLowerCase();
  if (lower.startsWith('new') || lower.includes('new →') || lower === 'new-contacted') return 'New';
  if (lower.startsWith('contacted') || lower.includes('contacted →') || lower === 'contacted-walkthrough-scheduled') return 'Contacted';
  if (
    lower.includes('walkthrough completed') ||
    lower.includes('walkthrough-completed') ||
    lower === 'walkthrough-completed-estimate'
  ) {
    return 'Walkthrough Completed';
  }
  if (lower.includes('walkthrough scheduled') || lower.includes('walkthrough-scheduled')) {
    return 'Walkthrough Scheduled';
  }
  if (lower.includes('walkthrough')) {
    return 'Walkthrough Completed';
  }
  if (lower === 'estimate' || lower === 'estimated' || lower.startsWith('estimate')) return 'Estimate';
  if (lower.includes('won')) return 'Won';
  if (lower.includes('lost')) return 'Lost';
  if (lower.includes('cancel')) return 'Cancelled';
  return s;
}

export function formatHumanReadableDuration(totalSeconds: number): string {
  if (totalSeconds < 0) totalSeconds = 0;

  const days = Math.floor(totalSeconds / 86400);
  if (days >= 1) {
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }

  const hours = Math.floor(totalSeconds / 3600);
  if (hours >= 1) {
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  if (minutes >= 1) {
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }

  return '1 minute';
}

export type SpiderStageCategory = 'new_lead' | 'contacted' | 'walkthrough';

export function getSpiderStageCategory(stageLabelOrId?: string): SpiderStageCategory {
  const s = (stageLabelOrId || '').toLowerCase().trim();

  if (s === 'new' || s.startsWith('new') || s.includes('new →') || s.includes('new-contacted')) {
    return 'new_lead';
  }

  if (
    s === 'estimate' ||
    s.includes('estimate') ||
    s.includes('walkthrough-completed-estimate') ||
    s.includes('walkthrough-scheduled-estimate') ||
    s.includes('walkthrough completed') ||
    s.includes('walkthrough-completed') ||
    s.includes('walkthrough completed → estimate') ||
    s.includes('walkthrough scheduled → estimate')
  ) {
    return 'walkthrough';
  }

  if (
    s === 'contacted' ||
    s.startsWith('contacted') ||
    s.includes('contacted →') ||
    s.includes('contacted-walkthrough-scheduled')
  ) {
    return 'contacted';
  }

  if (s.includes('walkthrough')) {
    return 'walkthrough';
  }

  return 'new_lead';
}

function resolveServiceAddress(lead: any, customer: any): string {
  if (lead?.service_location) {
    const loc = lead.service_location;
    const parts = [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }

  const directParts = [
    lead?.service_address_line1,
    lead?.service_address_line2,
    lead?.service_city,
    lead?.service_state,
    lead?.service_zip,
  ].filter(Boolean);
  if (directParts.length > 0) return directParts.join(', ');

  const primaryLoc = customer?.service_locations?.find((l: any) => l.is_primary) || customer?.service_locations?.[0];
  if (primaryLoc) {
    const parts = [primaryLoc.address_line1, primaryLoc.address_line2, primaryLoc.city, primaryLoc.state, primaryLoc.zip].filter(Boolean);
    if (parts.length > 0) return parts.join(', ');
  }
  return 'Service location on file';
}

/**
 * Dispatches Email, SMS, and In-App notifications for a Spider Agent overdue lead alert.
 */
export async function dispatchSpiderAlerts(
  params: DispatchSpiderAlertParams
): Promise<DispatchSpiderAlertResult> {
  const {
    organizationId,
    leadId,
    assignments,
    notifications,
    actorId,
    dedupeKey = null,
  } = params;

  // 1. Check deduplication key before doing any outbound dispatch (BUG-3 / B-1)
  if (dedupeKey) {
    const existing = await prisma.spiderAlertLog.findUnique({
      where: { dedupe_key: dedupeKey },
      select: { id: true },
    });
    if (existing) {
      return {
        ok: true,
        alreadyAlerted: true,
        recipientCount: 0,
        emailsSent: 0,
        emailsSkipped: 0,
        emailsFailed: 0,
        smsSent: 0,
        smsSkipped: 0,
        smsFailed: 0,
        inAppEmitted: false,
      };
    }
  }

  // 2. Fetch Lead with strict tenant isolation (SEC-2)
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, organization_id: organizationId },
    include: {
      customer: {
        include: {
          service_locations: true,
        },
      },
      service_location: true,
      commission_owner: true,
      lead_assignees: { include: { user: true } },
      contact_setter: { select: { id: true, first_name: true, last_name: true, email: true } },
    },
  });

  if (!lead) {
    logger.warn('[spiderDispatch] Lead not found for alert dispatch', { leadId, organizationId });
    return {
      ok: false,
      recipientCount: 0,
      emailsSent: 0,
      emailsSkipped: 0,
      emailsFailed: 0,
      smsSent: 0,
      smsSkipped: 0,
      smsFailed: 0,
      inAppEmitted: false,
      error: 'Lead not found',
    };
  }

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, logo_url: true, brand_color: true },
  });

  // 3. Load Role Holders and Resolve Recipient IDs
  const roleHolders = await loadRoleHolders(organizationId, prisma);
  const recipientIds = resolveSpiderAlertRecipients({
    assignments: {
      adminRoles: assignments.adminRoles || [],
      users: assignments.users || [],
      owner: !!assignments.owner,
    },
    lead: {
      id: lead.id,
      commission_owner_id: lead.commission_owner_id,
      commission_owner: lead.commission_owner,
      lead_assignees: lead.lead_assignees,
      lead_number: lead.lead_number,
    },
    roleHolders,
  });

  let recipientUsers = recipientIds.length > 0
    ? await prisma.user.findMany({
        where: {
          id: { in: recipientIds },
          organization_id: organizationId,
          has_login: true,
        },
        select: {
          id: true,
          email: true,
          phone: true,
          first_name: true,
          last_name: true,
          role: true,
        },
      })
    : [];

  // Fallback: System Admins of the organization
  if (recipientUsers.length === 0) {
    recipientUsers = await prisma.user.findMany({
      where: {
        organization_id: organizationId,
        role: 'ADMIN',
        has_login: true,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        first_name: true,
        last_name: true,
        role: true,
      },
    });
  }

  const customerName = `${lead.customer.first_name || ''} ${lead.customer.last_name || ''}`.trim() ||
    lead.customer.company_name ||
    'Customer';

  const assignedUserObj = lead.lead_assignees?.[0]?.user || lead.commission_owner || (lead as any).assigned_to_user || null;
  let assignedUserName = assignedUserObj
    ? `${assignedUserObj.first_name || ''} ${assignedUserObj.last_name || ''}`.trim() || assignedUserObj.email
    : 'Unassigned';

  const rawOwnerId = getSpiderLeadOwnerId(lead);
  if (assignedUserName === 'Unassigned' && rawOwnerId) {
    const matchedUser = recipientUsers.find((u) => u.id === rawOwnerId);
    if (matchedUser) {
      assignedUserName = `${matchedUser.first_name || ''} ${matchedUser.last_name || ''}`.trim() || matchedUser.email || 'Unassigned';
    }
  }

  const stageName = normalizeSpiderStageName(params.stageLabel || 'New');
  const timeInStageStr = params.elapsedValue !== undefined && params.elapsedUnit
    ? (() => {
        const rawUnit = String(params.elapsedUnit).toLowerCase().replace(/s$/, '');
        let totalSecs = params.elapsedSeconds || 0;
        if (!totalSecs) {
          if (rawUnit === 'minute') totalSecs = params.elapsedValue * 60;
          else if (rawUnit === 'hour') totalSecs = params.elapsedValue * 3600;
          else if (rawUnit === 'day') totalSecs = params.elapsedValue * 86400;
          else totalSecs = params.elapsedValue;
        }
        return formatHumanReadableDuration(totalSecs);
      })()
    : 'Overdue duration';

  const serviceLocation = resolveServiceAddress(lead, lead.customer);
  const leadNumberStr = lead.lead_number ? `LD-${lead.lead_number.replace(/^LD-/i, '')}` : `Lead #${lead.id.slice(0, 6)}`;
  const baseUrl = (params.appBaseUrl || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const leadUrl = `${baseUrl}/leads/${lead.id}`;

  const stageCat = getSpiderStageCategory(stageName);
  let stageEnteredAt: Date | null = null;
  if (stageCat === 'new_lead') {
    stageEnteredAt = lead.created_at ? new Date(lead.created_at) : null;
  } else if (stageCat === 'contacted') {
    stageEnteredAt = lead.contacted_at ? new Date(lead.contacted_at) : (lead.created_at ? new Date(lead.created_at) : null);
  } else {
    stageEnteredAt = (lead as any).last_visit_completed_at
      ? new Date((lead as any).last_visit_completed_at)
      : (lead as any).walkthrough_completed_at
      ? new Date((lead as any).walkthrough_completed_at)
      : (lead.updated_at ? new Date(lead.updated_at) : (lead.created_at ? new Date(lead.created_at) : null));
  }
  let stageSentence = '';
  if (stageCat === 'new_lead') {
    stageSentence = `This lead was created ${timeInStageStr} ago and has not yet been contacted.`;
  } else if (stageCat === 'contacted') {
    stageSentence = `This lead was contacted ${timeInStageStr} ago, but a walkthrough has not yet been scheduled.`;
  } else {
    stageSentence = `The walkthrough was completed ${timeInStageStr} ago, but an estimate has not yet been sent.`;
  }

  const alertHeader = `Spider Alert - ${customerName} (${leadNumberStr})`;
  const fullTextMessage = `${alertHeader}\n${stageSentence}\n\nView lead: ${leadUrl}`;

  // 4. Reserve Alert Log Row in Database to prevent concurrent races (B-1)
  let logId: string | null = null;
  const recipientsJson = recipientUsers.map((u) => ({
    id: u.id,
    name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
    email: u.email,
    phone: u.phone,
    role: u.role || 'Member',
    type: u.id === rawOwnerId ? 'owner' : 'user',
  }));

  try {
    const createdLog = await prisma.spiderAlertLog.create({
      data: {
        organization_id: organizationId,
        lead_id: lead.id,
        lead_number: leadNumberStr,
        customer_id: lead.customer_id || lead.customer?.id || null,
        customer_name: customerName,
        company_name: lead.customer?.company_name || null,
        service_request: lead.service_request || null,
        service_location: serviceLocation,
        stage_name: stageName,
        inactive_days: params.elapsedValue || 0,
        inactive_unit: params.elapsedUnit || 'Day',
        channels: {
          email: { enabled: !!notifications.email },
          sms: { enabled: !!notifications.sms },
          inApp: { enabled: !!notifications.inApp },
        },
        recipients: recipientsJson,
        email_subject: `Spider Alert - ${customerName} (${leadNumberStr})`,
        email_body: fullTextMessage,
        sms_message: fullTextMessage,
        in_app_message: stageSentence,
        dedupe_key: dedupeKey,
        status: 'PENDING',
      },
    });
    logId = createdLog.id;
  } catch (dbErr: any) {
    if (dbErr?.code === 'P2002') {
      logger.info('[spiderDispatch] Unique dedupe key collision, skipping duplicate dispatch', { dedupeKey, leadId: lead.id });
      return {
        ok: true,
        alreadyAlerted: true,
        recipientCount: 0,
        emailsSent: 0,
        emailsSkipped: 0,
        emailsFailed: 0,
        smsSent: 0,
        smsSkipped: 0,
        smsFailed: 0,
        inAppEmitted: false,
      };
    }
    logger.warn('[spiderDispatch] Warning creating pending alert log:', dbErr);
  }

  // 5. Dispatch Email Alerts
  let emailsSent = 0;
  let emailsSkipped = 0;
  let emailsFailed = 0;
  let lastEmailError: string | null = null;

  if (notifications.email) {
    const emailSubject = `Spider Alert - ${customerName} (${leadNumberStr})`;

    for (const recipient of recipientUsers) {
      if (!recipient.email) {
        emailsSkipped++;
        continue;
      }

      const recipientName = `${recipient.first_name || ''} ${recipient.last_name || ''}`.trim() || 'Team Member';

      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b;">
          <div style="background-color: #0c2d3a; padding: 18px 24px; border-radius: 8px 8px 0 0; text-align: left;">
            <span style="font-size: 13px; font-weight: 700; color: #f87171; text-transform: uppercase; letter-spacing: 0.5px;">🕷️ Spider AI Lead Watcher Alert</span>
            <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 20px; font-weight: 600;">Spider Alert - ${esc(customerName)} (${esc(leadNumberStr)})</h2>
          </div>
          <div style="background-color: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; line-height: 1.5; margin-top: 0;">Hi ${esc(recipientName)},</p>
            <p style="font-size: 15px; line-height: 1.6; color: #1e293b; font-weight: 500; background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
              ${esc(stageSentence)}
            </p>

            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #f8fafc; border-radius: 6px; overflow: hidden;">
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; width: 35%; border-bottom: 1px solid #e2e8f0;">Lead Number:</td>
                <td style="padding: 10px 14px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(leadNumberStr)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Customer:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(customerName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Assigned To:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(assignedUserName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Current Stage:</td>
                <td style="padding: 10px 14px; color: #dc2626; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(stageName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Time in Stage:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(timeInStageStr)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600;">Service Location:</td>
                <td style="padding: 10px 14px; color: #0f172a;">${esc(serviceLocation)}</td>
              </tr>
            </table>

            <div style="text-align: center; margin-top: 25px; margin-bottom: 15px;">
              <a href="${esc(leadUrl)}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
                View lead: ${esc(leadUrl)}
              </a>
            </div>
          </div>
        </div>
      `;

      try {
        const emailResult = await sendAutomationEmail({
          organizationId: org?.id || organizationId,
          to: recipient.email,
          subject: emailSubject,
          text: fullTextMessage,
          html: emailHtml,
          senderIdentity: 'spider-alert',
          org: {
            id: org?.id || organizationId,
            name: org?.name || 'ServWave Spider Alerts',
            logo_url: org?.logo_url || null,
            brand_color: org?.brand_color || '#0C2D3A',
          },
        });

        if (emailResult.status === 'sent') {
          emailsSent++;
          logger.info('[spiderDispatch] Alert email sent successfully', { userId: recipient.id, leadId: lead.id });
        } else if (emailResult.status === 'skipped') {
          emailsSkipped++;
          logger.info('[spiderDispatch] Alert email skipped', { userId: recipient.id, reason: emailResult.reason });
        } else {
          emailsFailed++;
          const errReason = mapEmailDeliveryFailureReason(emailResult.error);
          lastEmailError = lastEmailError || errReason;
          logger.warn('[spiderDispatch] Email delivery rejected or failed', { userId: recipient.id, reason: errReason });
        }
      } catch (err: any) {
        logger.warn('[spiderDispatch] Failed to dispatch Spider alert email', { userId: recipient.id, error: err?.message });
        emailsFailed++;
        lastEmailError = lastEmailError || mapEmailDeliveryFailureReason(err?.message);
      }
    }
  }

  // 6. Dispatch SMS Alerts to Staff Only (SEC-4: direct send without message threads or inbox rows)
  let smsSent = 0;
  let smsSkipped = 0;
  let smsFailed = 0;
  let lastSmsError: string | null = null;

  if (notifications.sms) {
    const smsBody = fullTextMessage;

    for (const recipient of recipientUsers) {
      const destinationPhone = recipient.phone;

      if (!destinationPhone) {
        smsSkipped++;
        logger.info('[spiderDispatch] Skipping SMS - staff recipient has no phone on file', { userId: recipient.id });
        continue;
      }

      try {
        const delivery = await sendStaffAlertSms(prisma, {
          orgId: organizationId,
          toE164: destinationPhone,
          body: smsBody,
        });

        if (delivery.delivered) {
          smsSent++;
          logger.info('[spiderDispatch] Alert SMS sent successfully to staff', { userId: recipient.id, leadId: lead.id, phone: destinationPhone });
        } else {
          smsFailed++;
          const smsFailReason = mapSmsDeliveryFailureReason(delivery.reason);
          lastSmsError = lastSmsError || smsFailReason;
          logger.warn('[spiderDispatch] Staff alert SMS delivery failed', { userId: recipient.id, reason: smsFailReason });
        }
      } catch (err: any) {
        logger.warn('[spiderDispatch] Failed to dispatch Spider alert SMS', { userId: recipient.id, error: err?.message });
        smsFailed++;
        lastSmsError = lastSmsError || 'Text message could not be delivered';
      }
    }
  }

  // 7. Emit In-App notification event if enabled
  let inAppEmitted = false;
  if (notifications.inApp) {
    try {
      const emittedRecipients = await emit({
        verb: 'spider.alert',
        organizationId,
        actorId: actorId || null,
        object: { type: 'LEAD', id: lead.id, label: leadNumberStr },
        entity: {
          ...lead,
          admin_roles: assignments.adminRoles,
          user_ids: assignments.users,
          owner: assignments.owner,
          lead_owner_id: rawOwnerId,
          roleHolders,
        },
        data: {
          customer_name: customerName,
          stage_name: stageName,
          time_in_stage: timeInStageStr,
          stage_entered_at: stageEnteredAt ? stageEnteredAt.toISOString() : null,
          title: alertHeader,
          body: stageSentence,
          full_message: fullTextMessage,
          lead_url: leadUrl,
        },
        dedupKey: dedupeKey || `spider-${lead.id}-${stageName}-${Math.floor(Date.now() / 1800000)}`,
      });
      inAppEmitted = emittedRecipients.length > 0;
    } catch (err) {
      logger.warn('[spiderDispatch] In-app notification emit error', { error: err });
    }
  }

  // 8. Update Log Row Status
  if (logId) {
    try {
      const emailStatus = !notifications.email
        ? 'SKIPPED'
        : emailsSent > 0
        ? 'SENT'
        : emailsFailed > 0
        ? 'FAILED'
        : 'SKIPPED';

      const smsStatus = !notifications.sms
        ? 'SKIPPED'
        : smsSent > 0
        ? 'SENT'
        : smsFailed > 0
        ? 'FAILED'
        : 'SKIPPED';

      const inAppStatus = !notifications.inApp ? 'SKIPPED' : inAppEmitted ? 'SENT' : 'SKIPPED';
      const isPartial =
        (emailsFailed > 0 && emailsSent > 0) || (smsFailed > 0 && smsSent > 0);
      const isFailed =
        (notifications.email && emailsSent === 0 && emailsFailed > 0) ||
        (notifications.sms && smsSent === 0 && smsFailed > 0);
      const finalLogStatus = isFailed ? 'FAILED' : isPartial ? 'PARTIAL' : (emailsSent > 0 || smsSent > 0 || inAppEmitted) ? 'SENT' : 'SKIPPED';

      await prisma.spiderAlertLog.update({
        where: { id: logId },
        data: {
          status: finalLogStatus,
          channels: {
            email: {
              enabled: !!notifications.email,
              status: emailStatus,
              sent: emailsSent,
              skipped: emailsSkipped,
              failed: emailsFailed,
              error: lastEmailError,
              from: 'ServWave Spider Alerts <alerts@spider.servwave.com>',
            },
            sms: {
              enabled: !!notifications.sms,
              status: smsStatus,
              sent: smsSent,
              skipped: smsSkipped,
              failed: smsFailed,
              error: lastSmsError,
            },
            inApp: {
              enabled: !!notifications.inApp,
              status: inAppStatus,
            },
          },
        },
      });
    } catch (updateErr) {
      logger.warn('[spiderDispatch] Failed to update final alert log status:', updateErr);
    }
  }

  return {
    ok: true,
    recipientCount: recipientUsers.length,
    emailsSent,
    emailsSkipped,
    emailsFailed,
    smsSent,
    smsSkipped,
    smsFailed,
    inAppEmitted,
  };
}

