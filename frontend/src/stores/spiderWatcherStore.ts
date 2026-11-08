import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import api from '@/lib/axios';
import { customerDisplayName } from '@/lib/customer-name';
import { registerStoreReset } from '@/lib/storeReset';

export type TimeUnit = 'Second' | 'Minute' | 'Hour' | 'Day';

export interface LeadStageConfig {
  id: string;
  label: string;
  fromStage: string;
  toStage: string;
  duration?: number;
  unit: TimeUnit;
  enabled?: boolean;
  description?: string;
}

export interface WatcherLead {
  id: string;
  leadNumber: string;
  serviceRequest?: string;
  serviceLocation?: string;
  service_location_id?: string | null;
  service_location?: any;
  service_address_line1?: string | null;
  service_address_line2?: string | null;
  service_city?: string | null;
  service_state?: string | null;
  service_zip?: string | null;
  stageId: string;
  stageLabel: string;
  elapsedValue: number;
  elapsedUnit: TimeUnit;
  elapsedSeconds?: number;
  createdAt?: string;
  contactedAt?: string | null;
  walkthroughScheduledAt?: string | null;
  walkthroughCompletedAt?: string | null;
  stageEnteredAt?: string | null;
  stageTimestamps?: Record<string, string>;
  status?: string;
  // Lead Owner (Assigned To)
  assigned_to?: string | null;
  assigned_to_user_id?: string | null;
  owner_id?: string | null;
  commission_owner_id?: string | null;
  commission_owner?: any;
  assigned_to_user?: any;
  owner?: any;
  assignedToName?: string | null;
}

export interface WatcherCustomer {
  id: string;
  name: string;
  company?: string;
  email?: string;
  phone?: string;
  service_locations?: any[];
  leads: WatcherLead[];
}

export interface SystemRoleItem {
  id: string;
  label: string;
  description?: string;
}

export interface AssignmentUserItem {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  role: string;
  roleLabel?: string;
  avatar_url?: string | null;
}

export interface SpiderAssignmentsConfig {
  adminRoles: string[];
  owner: boolean;
  users: string[];
}

export interface SpiderNotificationsConfig {
  email: boolean;
  sms: boolean;
  inApp: boolean;
  redFrame?: boolean;
}

export interface InAppNotification {
  id: string;
  contactName: string;
  companyName: string;
  inactiveDays: number;
  message: string;
  timeAgo: string;
  read: boolean;
  contactId: string;
  leadId?: string;
  leadNumber?: string;
  leadStage?: string;
  serviceRequest?: string;
  serviceLocation?: string;
  contactedAt?: string | null;
  createdAt?: string | null;
  stageEnteredAt?: string | null;
  lastCommunication?: string | null;
  isTriggered?: boolean;
  assignedTo?: string | null;
  assignedToId?: string | null;
}

/** Convert a duration + unit to seconds for comparison */
export function timeUnitToSeconds(duration: number | undefined | null, unit: TimeUnit): number {
  const d = duration !== undefined && duration !== null ? duration : 0;
  switch (unit) {
    case 'Second':
      return d;
    case 'Minute':
      return d * 60;
    case 'Hour':
      return d * 3600;
    case 'Day':
      return d * 86400;
    default:
      return d;
  }
}

/**
 * Format stage label to only display the current stage name (e.g. 'New', 'Contacted', 'Walkthrough Completed', 'Estimate')
 */
export function formatCurrentStageName(stageLabelOrId?: string): string {
  if (!stageLabelOrId) return 'New';
  const lower = stageLabelOrId.toLowerCase().trim();
  if (lower.startsWith('new') || lower.includes('new →') || lower === 'new-contacted') return 'New';
  if (lower.startsWith('contacted') || lower.includes('contacted →') || lower === 'contacted-walkthrough-scheduled') return 'Contacted';
  if (
    lower.includes('walkthrough completed') ||
    lower.includes('walkthrough-completed') ||
    lower === 'walkthrough-completed-estimate' ||
    lower.includes('walkthrough')
  ) {
    return 'Walkthrough Completed';
  }
  if (lower.startsWith('estimate') || lower.includes('estimate')) return 'Estimate';
  if (lower.includes('won') || lower.includes('lost') || lower.includes('cancel') || lower.includes('closed')) return 'Closed';
  return stageLabelOrId;
}

/**
 * Checks if a lead has a completed walkthrough from the Lead Overview details
 * (walkthrough_completed_at, walkthroughCompletedAt, walkthrough_first_completed_at,
 * last_visit_completed_at, completed visit row, or WALKTHROUGH_COMPLETED status)
 */
export function isLeadWalkthroughCompleted(lead: any): boolean {
  if (!lead) return false;
  if (lead.walkthrough_completed_at || lead.walkthroughCompletedAt) return true;
  if (lead.walkthrough_first_completed_at || (lead as any).walkthroughFirstCompletedAt) return true;
  if (lead.last_visit_completed_at || (lead as any).lastVisitCompletedAt) return true;
  const statusUpper = (lead.status || '').toUpperCase().trim();
  if (statusUpper === 'WALKTHROUGH_COMPLETED' || statusUpper === 'COMPLETED') return true;
  if (Array.isArray(lead.visits) && lead.visits.some((v: any) => v.status === 'COMPLETED' || v.completed_at)) {
    return true;
  }
  return false;
}

/**
 * Checks if a lead has an actively scheduled walkthrough from Lead Overview details
 * (walkthrough_scheduled_at, walkthroughScheduledAt, scheduled_start, scheduled_at,
 * or scheduled visit in visits array), and is not yet completed or cancelled.
 */
export function isLeadWalkthroughScheduled(lead: any): boolean {
  if (!lead) return false;
  if (isLeadWalkthroughCompleted(lead)) return false;
  const isCancelled = Boolean(lead.walkthrough_cancelled_at || (lead as any).walkthroughCancelledAt);
  if (isCancelled) return false;

  const rawScheduledAt =
    lead.walkthrough_scheduled_at ||
    lead.walkthroughScheduledAt ||
    lead.scheduled_start ||
    (lead as any).scheduledStart ||
    (lead as any).scheduled_at ||
    (lead as any).scheduledAt;

  if (rawScheduledAt) return true;

  const statusUpper = String(lead.status || '').toUpperCase().trim();
  if (statusUpper === 'WALKTHROUGH_SCHEDULED') return true;

  if (Array.isArray(lead.visits)) {
    const hasScheduledVisit = lead.visits.some(
      (v: any) =>
        (v.status === 'SCHEDULED' || v.scheduled_at) &&
        !v.completed_at &&
        !v.cancelled_at
    );
    if (hasScheduledVisit) return true;
  }

  return false;
}

/**
 * Checks whether a lead is in one of the 3 allowed alert stages:
 * 1. New (standard Lead Status field: NEW)
 * 2. Contacted (standard Lead Status field: CONTACTED, excluding leads where a Walkthrough is already Scheduled)
 * 3. Walkthrough Completed (completion status directly from Lead Overview details)
 *
 * Excludes all leads in any other stage (such as Estimate, Walkthrough Scheduled, or Closed / Won / Lost / Cancelled).
 */
export function isLeadInAllowedAlertStage(lead: any): boolean {
  if (!lead) return false;

  const rawStatus = String(lead.status || '').toUpperCase().trim();
  const rawStageId = String(lead.stageId || '').toLowerCase().trim();
  const rawStageLabel = String(lead.stageLabel || '').toLowerCase().trim();

  // 1. Exclude Closed / Terminal statuses (WON, LOST, CANCELLED, CLOSED, ARCHIVED)
  if (
    rawStatus === 'WON' ||
    rawStatus === 'LOST' ||
    rawStatus === 'CANCELLED' ||
    rawStatus === 'CLOSED' ||
    rawStatus === 'ARCHIVED' ||
    rawStatus.includes('WON') ||
    rawStatus.includes('LOST') ||
    rawStatus.includes('CANCEL') ||
    rawStatus.includes('CLOSE') ||
    rawStageId === 'closed' ||
    rawStageLabel.includes('closed') ||
    rawStageLabel.includes('won') ||
    rawStageLabel.includes('lost') ||
    rawStageLabel.includes('cancel')
  ) {
    return false;
  }

  // 2. Exclude Estimate stage (status ESTIMATED / ESTIMATE / PROPOSAL_SENT / ESTIMATE_SENT or has estimates)
  const isEstimate =
    rawStatus === 'ESTIMATED' ||
    rawStatus === 'ESTIMATE' ||
    rawStatus === 'ESTIMATE_SENT' ||
    rawStatus === 'PROPOSAL_SENT' ||
    rawStatus.includes('ESTIMAT') ||
    rawStatus.includes('PROPOSAL') ||
    rawStageId === 'estimate' ||
    (rawStageLabel.includes('estimate') && !rawStageLabel.includes('walkthrough')) ||
    (Array.isArray(lead.estimates) && lead.estimates.length > 0) ||
    (typeof lead.estimates_count === 'number' && lead.estimates_count > 0) ||
    (typeof lead.estimate_count === 'number' && lead.estimate_count > 0) ||
    Boolean(lead.first_estimate_sent_at || (lead as any).firstEstimateSentAt);

  if (isEstimate) {
    return false;
  }

  // 3. Walkthrough Completed stage: pulled directly from Lead Overview details
  // (Only eligible if not in Estimate or Closed stage, which was already rejected above)
  if (isLeadWalkthroughCompleted(lead)) {
    return true;
  }

  // 4. Exclude Contacted leads that already have a Walkthrough Scheduled
  if (isLeadWalkthroughScheduled(lead)) {
    return false;
  }

  // 5. Contacted stage: check standard Lead Status field (or contacted_at)
  if (
    rawStatus === 'CONTACTED' ||
    rawStatus.includes('CONTACT') ||
    Boolean(lead.contacted_at || lead.contactedAt || (lead as any).last_contact_at || (lead as any).lastContactAt)
  ) {
    return true;
  }

  // 6. New stage: check standard Lead Status field (NEW or default initial lead)
  if (rawStatus === 'NEW' || rawStatus.includes('NEW') || !rawStatus) {
    return true;
  }

  return false;
}

/**
 * Calculates the current stage and actual time spent in that stage from real lead timestamps.
 * - For New and Contacted stages, checks the standard Lead Status field.
 * - For Walkthrough Completed stage, pulls completion status directly from Lead Overview details.
 * - When Spider activatedAt timestamp is provided, time is only measured forward from the moment of activation.
 */
export function resolveLeadStageAndElapsedTime(
  lead: {
    id?: string;
    created_at?: string | Date | null;
    createdAt?: string | Date | null;
    contacted_at?: string | Date | null;
    contactedAt?: string | Date | null;
    last_contact_at?: string | Date | null;
    lastContactAt?: string | Date | null;
    walkthrough_scheduled_at?: string | Date | null;
    walkthroughScheduledAt?: string | Date | null;
    scheduled_start?: string | Date | null;
    scheduledStart?: string | Date | null;
    walkthrough_completed_at?: string | Date | null;
    walkthroughCompletedAt?: string | Date | null;
    walkthrough_first_completed_at?: string | Date | null;
    walkthroughFirstCompletedAt?: string | Date | null;
    last_visit_completed_at?: string | Date | null;
    lastVisitCompletedAt?: string | Date | null;
    visits?: any[] | null;
    status?: string | null;
    estimates?: any[] | null;
    first_estimate_sent_at?: string | Date | null;
    firstEstimateSentAt?: string | Date | null;
    updated_at?: string | Date | null;
    updatedAt?: string | Date | null;
    stageEnteredAt?: string | Date | null;
    stage_entered_at?: string | Date | null;
    stageTimestamps?: Record<string, string>;
    elapsedValue?: number;
    elapsedUnit?: TimeUnit;
    elapsedSeconds?: number;
    stageId?: string;
    stageLabel?: string;
  },
  activatedAt?: string | Date | null,
  stageTimestamps?: Record<string, string>
): {
  stageId: string;
  stageLabel: string;
  elapsedSeconds: number;
  elapsedValue: number;
  elapsedUnit: TimeUnit;
  contactedAt?: string | null;
  stageEnteredAt?: string | null;
} {
  const now = Date.now();

  const rawCreatedAt = lead.created_at || (lead as any).createdAt;
  const createdAt = rawCreatedAt ? new Date(rawCreatedAt).getTime() : now;
  const rawContactedAt = lead.contacted_at || lead.contactedAt || (lead as any).last_contact_at || (lead as any).lastContactAt;
  const contactedAt = rawContactedAt ? new Date(rawContactedAt).getTime() : null;

  const rawCompletedAt =
    lead.walkthrough_completed_at ||
    lead.walkthroughCompletedAt ||
    lead.walkthrough_first_completed_at ||
    (lead as any).walkthroughFirstCompletedAt ||
    lead.last_visit_completed_at ||
    (lead as any).lastVisitCompletedAt;

  const visitCompleted = Array.isArray(lead.visits)
    ? lead.visits.find((v: any) => v.status === 'COMPLETED' || v.completed_at)
    : null;
  const completedAt = rawCompletedAt
    ? new Date(rawCompletedAt).getTime()
    : (visitCompleted?.completed_at ? new Date(visitCompleted.completed_at).getTime() : null);

  const status = String(lead.status || '').toUpperCase().trim();
  const isClosed =
    ['WON', 'LOST', 'CANCELLED', 'CLOSED', 'ARCHIVED'].includes(status) ||
    status.includes('WON') ||
    status.includes('LOST') ||
    status.includes('CANCEL') ||
    status.includes('CLOSE');

  const hasEstimates =
    status === 'ESTIMATED' ||
    status === 'ESTIMATE' ||
    status === 'ESTIMATE_SENT' ||
    status === 'PROPOSAL_SENT' ||
    status.includes('ESTIMAT') ||
    status.includes('PROPOSAL') ||
    (Array.isArray(lead.estimates) && lead.estimates.length > 0) ||
    (typeof (lead as any).estimates_count === 'number' && (lead as any).estimates_count > 0) ||
    (typeof (lead as any).estimate_count === 'number' && (lead as any).estimate_count > 0) ||
    Boolean(lead.first_estimate_sent_at || (lead as any).firstEstimateSentAt);

  let stageId = 'new-contacted';
  let stageLabel = 'New → Contacted';

  // Determine stage based on progression rules
  if (isClosed) {
    stageId = 'closed';
    stageLabel = 'Closed';
  } else if (hasEstimates) {
    stageId = 'estimate';
    stageLabel = 'Estimate';
  } else if (completedAt || status === 'WALKTHROUGH_COMPLETED' || isLeadWalkthroughCompleted(lead)) {
    // Stage 3: Walkthrough Completed (pulled directly from Lead Overview details)
    stageId = 'walkthrough-completed-estimate';
    stageLabel = 'Walkthrough Completed → Estimate';
  } else if (status === 'CONTACTED' || status.includes('CONTACT') || contactedAt) {
    // Stage 2: Contacted (check standard Lead Status field)
    stageId = 'contacted-walkthrough-scheduled';
    stageLabel = 'Contacted → Walkthrough Scheduled';
  } else {
    // Stage 1: New (check standard Lead Status field)
    stageId = 'new-contacted';
    stageLabel = 'New → Contacted';
  }

  // Resolve the exact timestamp when this lead entered its current stage
  const leadId = lead.id;
  let stageStartTime: number = now;

  const getRegisteredStageTime = (sId: string): number | null => {
    if (stageTimestamps) {
      const entryByKey = leadId ? stageTimestamps[`${leadId}:${sId}`] : undefined;
      if (entryByKey) {
        const t = new Date(entryByKey).getTime();
        if (!isNaN(t)) return t;
      }
      const entryByStage = stageTimestamps[sId];
      if (entryByStage) {
        const t = new Date(entryByStage).getTime();
        if (!isNaN(t)) return t;
      }
    }
    if (lead.stageTimestamps) {
      const entryFromLead = lead.stageTimestamps[sId];
      if (entryFromLead) {
        const t = new Date(entryFromLead).getTime();
        if (!isNaN(t)) return t;
      }
    }
    if (lead.stageEnteredAt || (lead as any).stage_entered_at) {
      const t = new Date((lead.stageEnteredAt || (lead as any).stage_entered_at)!).getTime();
      if (!isNaN(t)) return t;
    }
    return null;
  };

  const registeredTime = getRegisteredStageTime(stageId);

  if (stageId === 'walkthrough-completed-estimate') {
    stageStartTime =
      completedAt ||
      registeredTime ||
      (lead.updated_at || (lead as any).updatedAt ? new Date(lead.updated_at || (lead as any).updatedAt).getTime() : now);
  } else if (stageId === 'contacted-walkthrough-scheduled') {
    stageStartTime =
      contactedAt ||
      registeredTime ||
      (lead.updated_at || (lead as any).updatedAt ? new Date(lead.updated_at || (lead as any).updatedAt).getTime() : now);
  } else if (stageId === 'estimate') {
    stageStartTime =
      (lead.first_estimate_sent_at || (lead as any).firstEstimateSentAt
        ? new Date(lead.first_estimate_sent_at || (lead as any).firstEstimateSentAt).getTime()
        : null) ||
      registeredTime ||
      (lead.updated_at || (lead as any).updatedAt ? new Date(lead.updated_at || (lead as any).updatedAt).getTime() : createdAt);
  } else if (stageId === 'closed') {
    stageStartTime = registeredTime || (lead.updated_at || (lead as any).updatedAt ? new Date(lead.updated_at || (lead as any).updatedAt).getTime() : createdAt);
  } else {
    // Stage 1: New -> Contacted
    stageStartTime = registeredTime || createdAt;
  }

  // If activatedAt timestamp is provided and stage started before Spider was activated,
  // measure stage duration forward from activation
  if (activatedAt) {
    const actMs = new Date(activatedAt).getTime();
    if (!isNaN(actMs)) {
      stageStartTime = Math.max(stageStartTime, actMs);
    }
  }

  // If explicit elapsed fallback is present without timestamps
  if (!rawCreatedAt && !rawContactedAt && !rawCompletedAt && registeredTime === null && lead.elapsedValue !== undefined && lead.elapsedUnit !== undefined) {
    const elapsedSeconds = timeUnitToSeconds(lead.elapsedValue, lead.elapsedUnit);
    return {
      stageId: lead.stageId || stageId,
      stageLabel: lead.stageLabel || stageLabel,
      elapsedSeconds,
      elapsedValue: lead.elapsedValue,
      elapsedUnit: lead.elapsedUnit,
      contactedAt: rawContactedAt ? String(rawContactedAt) : null,
      stageEnteredAt: null,
    };
  }

  const elapsedMs = Math.max(0, now - stageStartTime);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  let elapsedValue = elapsedSeconds;
  let elapsedUnit: TimeUnit = 'Second';

  if (elapsedSeconds >= 86400) {
    elapsedValue = Math.floor(elapsedSeconds / 86400);
    elapsedUnit = 'Day';
  } else if (elapsedSeconds >= 3600) {
    elapsedValue = Math.floor(elapsedSeconds / 3600);
    elapsedUnit = 'Hour';
  } else if (elapsedSeconds >= 60) {
    elapsedValue = Math.floor(elapsedSeconds / 60);
    elapsedUnit = 'Minute';
  } else {
    elapsedValue = Math.max(1, elapsedSeconds);
    elapsedUnit = 'Second';
  }

  return {
    stageId,
    stageLabel,
    elapsedSeconds,
    elapsedValue,
    elapsedUnit,
    contactedAt: rawContactedAt ? String(rawContactedAt) : null,
    stageEnteredAt: new Date(stageStartTime).toISOString(),
  };
}

/** Check whether a lead has exceeded the stage threshold */
export function isLeadOverdue(
  lead: WatcherLead,
  stageConfigs: LeadStageConfig[],
  isActive: boolean = true,
  activatedAt?: string | Date | null,
  stageTimestamps?: Record<string, string>
): boolean {
  if (!isActive) {
    return false;
  }

  // Only consider leads in allowed stages for alerts
  if (!isLeadInAllowedAlertStage(lead)) {
    return false;
  }

  // Determine current stage & elapsed seconds from progression metrics
  const stageMetrics = resolveLeadStageAndElapsedTime(lead, activatedAt, stageTimestamps);
  const resolvedStageId = stageMetrics.stageId;
  const resolvedStageLabel = stageMetrics.stageLabel;

  // If lead is in contacted-walkthrough-scheduled stage, but a walkthrough has already been scheduled, it is not overdue
  if (
    resolvedStageId === 'contacted-walkthrough-scheduled' ||
    resolvedStageLabel.includes('Walkthrough Scheduled')
  ) {
    const rawWtScheduled =
      lead.walkthroughScheduledAt ||
      (lead as any).walkthrough_scheduled_at ||
      (lead as any).scheduled_start ||
      (lead as any).scheduledStart;
    const rawWtCancelled = (lead as any).walkthrough_cancelled_at || (lead as any).walkthroughCancelledAt;
    const isWtActive = Boolean(rawWtScheduled && !rawWtCancelled);
    if (isWtActive) {
      return false;
    }
  }

  let leadSeconds = stageMetrics.elapsedSeconds;
  if (!lead.createdAt && !(lead as any).created_at && lead.elapsedSeconds !== undefined) {
    leadSeconds = lead.elapsedSeconds;
  }

  const config = stageConfigs.find(
    (s) =>
      s.id === resolvedStageId ||
      s.label === resolvedStageLabel ||
      s.id === lead.stageId ||
      s.label === lead.stageLabel ||
      (s.fromStage && s.toStage && ((resolvedStageLabel.includes(s.fromStage) && resolvedStageLabel.includes(s.toStage)) || (lead.stageLabel && lead.stageLabel.includes(s.fromStage) && lead.stageLabel.includes(s.toStage)))) ||
      (s.fromStage && (lead.status || '').toUpperCase() === s.fromStage.toUpperCase())
  );

  if (
    !config ||
    config.enabled === false ||
    config.duration === undefined ||
    config.duration === null ||
    isNaN(config.duration)
  ) {
    return false;
  }

  const thresholdSeconds = timeUnitToSeconds(config.duration, config.unit);
  return leadSeconds >= thresholdSeconds;
}

/**
 * Resolves the user-facing functional title for a stage
 */
export function getStageFunctionalTitle(stage: LeadStageConfig): string {
  const id = (stage.id || '').toLowerCase();
  const label = (stage.label || '').toLowerCase();
  if (id.includes('new') || label.includes('new')) {
    return 'Time to First Contact';
  }
  if (id.includes('walkthrough-completed-estimate') || id.includes('walkthrough-scheduled-estimate') || (label.includes('walkthrough') && label.includes('estimate'))) {
    return 'Time to Deliver Estimate';
  }
  if (id.includes('walkthrough') || label.includes('walkthrough')) {
    return 'Time to Schedule Walkthrough';
  }
  return stage.label;
}

/**
 * Returns the pipeline transition flow (e.g. "New → Contacted")
 */
export function getStagePipelineFlow(stage: LeadStageConfig): string {
  if (stage.fromStage && stage.toStage) {
    return `${stage.fromStage} → ${stage.toStage}`;
  }
  return stage.label;
}

/**
 * Provides a sensible default fallback duration when enabling a stage
 */
export function getDefaultFallbackDuration(stageId?: string, unit: TimeUnit = 'Minute'): number {
  return 1;
}

// Default 3 Lead Stages: New → Contacted, Contacted → Walkthrough Scheduled, Walkthrough Completed → Estimate
export const DEFAULT_LEAD_STAGES: LeadStageConfig[] = [
  {
    id: 'new-contacted',
    label: 'New → Contacted',
    fromStage: 'New',
    toStage: 'Contacted',
    duration: undefined,
    unit: 'Minute',
  },
  {
    id: 'contacted-walkthrough-scheduled',
    label: 'Contacted → Walkthrough Scheduled',
    fromStage: 'Contacted',
    toStage: 'Walkthrough Scheduled',
    duration: undefined,
    unit: 'Minute',
  },
  {
    id: 'walkthrough-completed-estimate',
    label: 'Walkthrough Completed → Estimate',
    fromStage: 'Walkthrough Completed',
    toStage: 'Estimate',
    duration: undefined,
    unit: 'Minute',
  },
];

// Default System Roles from Settings > Roles & Permissions
export const DEFAULT_SYSTEM_ROLES: SystemRoleItem[] = [
  {
    id: 'ADMIN',
    label: 'Administrator (Owner)',
    description: 'Full access to system and alert management',
  },
  {
    id: 'SALES',
    label: 'Sales',
    description: 'Lead pipelines, estimates, and customer communications',
  },
  {
    id: 'DISPATCHER',
    label: 'Dispatcher',
    description: 'Scheduling, job dispatch, and technician routing',
  },
  {
    id: 'TECHNICIAN',
    label: 'Technician',
    description: 'Field service execution and job completion',
  },
];

// Fallback users (empty in production, populated dynamically from API)
export const DEFAULT_ASSIGNMENT_USERS: AssignmentUserItem[] = [];

export const DEFAULT_ASSIGNMENTS_CONFIG: SpiderAssignmentsConfig = {
  adminRoles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'],
  owner: true,
  users: [],
};

export function normalizeAssignments(raw: any): SpiderAssignmentsConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_ASSIGNMENTS_CONFIG;
  if (Array.isArray(raw.adminRoles)) {
    return {
      adminRoles: Array.isArray(raw.adminRoles) ? raw.adminRoles : DEFAULT_ASSIGNMENTS_CONFIG.adminRoles,
      owner: typeof raw.owner === 'boolean' ? raw.owner : true,
      users: Array.isArray(raw.users) ? raw.users : DEFAULT_ASSIGNMENTS_CONFIG.users,
    };
  }
  return DEFAULT_ASSIGNMENTS_CONFIG;
}

/**
 * Resolves the lead owner ID from a lead record (e.g. commission_owner, assigned_to user)
 */
export function getSpiderLeadOwnerId(lead: Partial<WatcherLead> | Record<string, any> | undefined | null): string | null {
  if (!lead) return null;
  return (
    lead.commission_owner_id ||
    (typeof lead.commission_owner === 'object' && lead.commission_owner?.id) ||
    lead.assigned_to_user_id ||
    (typeof lead.assigned_to_user === 'object' && lead.assigned_to_user?.id) ||
    (typeof lead.owner === 'object' && lead.owner?.id) ||
    lead.owner_id ||
    (typeof lead.assigned_to === 'string' ? lead.assigned_to : (lead.assigned_to?.id || null)) ||
    null
  );
}

/**
 * Resolves the lead owner display name from a lead record
 */
export function getSpiderLeadOwnerName(lead: Partial<WatcherLead> | Record<string, any> | undefined | null): string | null {
  if (!lead) return null;
  if (lead.assignedToName) return lead.assignedToName;
  const ownerObj =
    lead.commission_owner ||
    lead.assigned_to_user ||
    lead.owner ||
    (typeof lead.assigned_to === 'object' ? lead.assigned_to : null);
  if (ownerObj) {
    const fullName = `${ownerObj.first_name || ''} ${ownerObj.last_name || ''}`.trim();
    if (fullName) return fullName;
    if (ownerObj.name) return ownerObj.name;
    if (ownerObj.email) return ownerObj.email;
  }
  return null;
}

/**
 * Resolves recipients for a Spider Alert based on Assignment rules:
 * 1. If Admin roles are selected, alerts are sent to those selected roles.
 * 2. If User is selected, alerts are sent directly to those specific users.
 * 3. If Owner is selected, alerts are sent strictly to the owner of that specific lead.
 */
export function resolveSpiderAlertRecipients(params: {
  assignments: SpiderAssignmentsConfig;
  lead: Partial<WatcherLead>;
  allUsers?: AssignmentUserItem[];
}): string[] {
  const { assignments, lead, allUsers = DEFAULT_ASSIGNMENT_USERS } = params;
  const recipients = new Set<string>();

  // 1. Admin roles: Include all users matching the selected Admin roles
  if (Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0) {
    const matchingUsers = allUsers.filter((u) => assignments.adminRoles.includes(u.role));
    matchingUsers.forEach((u) => recipients.add(u.id));
  }

  // 2. Explicit user IDs if any
  if (Array.isArray(assignments.users) && assignments.users.length > 0) {
    assignments.users.forEach((userId) => recipients.add(userId));
  }

  // 3. Lead Owner: If Owner is checked, strictly include the owner of this specific lead
  if (assignments.owner) {
    const ownerId = getSpiderLeadOwnerId(lead);
    if (ownerId) {
      recipients.add(ownerId);
    }
  }

  // Union & de-duplicated
  return Array.from(recipients);
}

/**
 * Check if a given user is an assigned recipient for a lead alert based on Assignment settings:
 * 1. If Admin roles are selected, users holding those roles receive alerts.
 * 2. If specific users are selected, those users receive alerts.
 * 3. If Owner is selected, the owner of this specific lead strictly receives alerts.
 * 4. If nothing is selected (or no role/user/owner matches the user), the user receives NO alert.
 */
export function isUserAssignedToSpiderAlert(
  assignments: SpiderAssignmentsConfig | undefined | null,
  lead: Partial<WatcherLead>,
  user?: { id?: string; role?: string; email?: string; first_name?: string; last_name?: string } | null
): boolean {
  // If no assignments config, or if no user is provided, default to delivering the alert
  if (!assignments) return true;

  const hasAdminRoles = Array.isArray(assignments.adminRoles) && assignments.adminRoles.length > 0;
  const hasUsers = Array.isArray(assignments.users) && assignments.users.length > 0;
  const hasOwner = !!assignments.owner;

  // If nothing is configured at all in assignments, do not assign to anyone
  if (!hasAdminRoles && !hasUsers && !hasOwner) {
    return false;
  }

  // If no user context is passed (e.g. background check or server log view), deliver
  if (!user) {
    return true;
  }

  const userRoleLower = (user.role || '').toLowerCase().replace(/[\s_-]+/g, '');
  const isAdminOrManager =
    userRoleLower === 'admin' ||
    userRoleLower === 'owner' ||
    userRoleLower === 'superadmin' ||
    userRoleLower === 'systemadmin' ||
    userRoleLower.includes('admin') ||
    userRoleLower.includes('manager');

  // 1. Check if user's role matches any of the selected Admin roles (case-insensitive & token normalized)
  if (hasAdminRoles) {
    const isMatchedRole = assignments.adminRoles.some((roleKey) => {
      const rKeyLower = roleKey.toLowerCase().replace(/[\s_-]+/g, '');
      return (
        rKeyLower === userRoleLower ||
        (rKeyLower.includes('admin') && (userRoleLower.includes('admin') || userRoleLower.includes('owner') || userRoleLower === 'systemadmin')) ||
        (rKeyLower.includes('manager') && userRoleLower.includes('manager')) ||
        (rKeyLower.includes('sales') && userRoleLower.includes('sales')) ||
        (rKeyLower.includes('dispatch') && userRoleLower.includes('dispatch')) ||
        (rKeyLower.includes('tech') && userRoleLower.includes('tech')) ||
        userRoleLower === 'admin' ||
        userRoleLower === 'owner' ||
        userRoleLower === 'superadmin' ||
        userRoleLower === 'systemadmin'
      );
    });
    if (isMatchedRole) {
      // Check that if non-admin role (e.g. SALES) is selected, only that specific role matches
      const hasDirectRoleMatch = assignments.adminRoles.some((roleKey) => {
        const rKeyLower = roleKey.toLowerCase().replace(/[\s_-]+/g, '');
        return (
          rKeyLower === userRoleLower ||
          (rKeyLower.includes('admin') && isAdminOrManager) ||
          (rKeyLower.includes('manager') && userRoleLower.includes('manager')) ||
          (rKeyLower.includes('sales') && userRoleLower.includes('sales')) ||
          (rKeyLower.includes('dispatch') && userRoleLower.includes('dispatch')) ||
          (rKeyLower.includes('tech') && userRoleLower.includes('tech'))
        );
      });
      if (hasDirectRoleMatch) {
        return true;
      }
    }
  }

  // 2. Check if user is explicitly in the selected users list
  if (hasUsers && assignments.users && assignments.users.length > 0) {
    const isExplicitlySelectedUser = assignments.users.some((uId) => {
      if (user.id && (uId === user.id || String(uId) === String(user.id))) return true;
      if (user.email && (uId.toLowerCase() === user.email.toLowerCase() || uId.includes(user.email.toLowerCase()))) return true;
      return false;
    });
    if (isExplicitlySelectedUser) {
      return true;
    }
  }

  // 3. Check if Owner is enabled and user is the assigned lead owner of this specific lead
  if (hasOwner) {
    const leadOwnerId = getSpiderLeadOwnerId(lead);
    if (leadOwnerId && user.id && (leadOwnerId === user.id || String(leadOwnerId) === String(user.id))) {
      return true;
    }

    // Also match by email or name if commission_owner object is attached
    const ownerObj = lead.commission_owner || lead.assigned_to_user || lead.owner;
    if (ownerObj) {
      if (ownerObj.id && user.id && String(ownerObj.id) === String(user.id)) {
        return true;
      }
      if (ownerObj.email && user.email && ownerObj.email.toLowerCase() === user.email.toLowerCase()) {
        return true;
      }
    }

    // Also match assignedTo / assignedToName
    const assignedName = (lead.assigned_to || lead.assignedToName || (lead as any).assignedTo || '').toLowerCase().trim();
    const userFullName = `${user.first_name || ''} ${user.last_name || ''}`.toLowerCase().trim();
    if (
      assignedName &&
      (assignedName === userFullName ||
        (user.email && assignedName === user.email.toLowerCase()) ||
        assignedName === (user as any).name?.toLowerCase())
    ) {
      return true;
    }

    // If lead is unassigned, notify admins/managers so unassigned leads are never neglected
    if (!leadOwnerId && !ownerObj && !assignedName && isAdminOrManager) {
      return true;
    }
  }

  return false;
}

const NOW = Date.now();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Auto-cleanup stale localStorage from legacy sessions containing mock IDs
if (typeof window !== 'undefined') {
  try {
    const raw = localStorage.getItem('servwave_spider_watcher_settings');
    if (raw && (raw.includes('"l1"') || raw.includes('"c1"') || raw.includes('"l2"') || raw.includes('"LD-101"'))) {
      localStorage.removeItem('servwave_spider_watcher_settings');
    }
  } catch {}
}

export const DEFAULT_WATCHER_CUSTOMERS: WatcherCustomer[] = [];


/**
 * Converts total seconds into a human-readable composite duration string:
 * - < 60 minutes → "X minutes"
 * - 60+ minutes → "X hours Y minutes"
 * - 24+ hours → "X days Y hours Z minutes"
 * - 30+ days → "X months Y days"
 * - 12+ months → "X years Y months"
 * e.g. 15773 minutes (946380s) → "10 days 22 hours 53 minutes"
 */
export function formatHumanReadableTimeSpan(totalSeconds: number): string {
  if (totalSeconds < 0) totalSeconds = 0;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 1) {
    const s = Math.floor(totalSeconds);
    return s <= 1 ? '1 second' : `${s} seconds`;
  }

  const minutesInHour = 60;
  const minutesInDay = 24 * 60; // 1440
  const minutesInMonth = 30 * 1440; // 43200
  const minutesInYear = 365 * 1440; // 525600

  let rem = totalMinutes;

  const years = Math.floor(rem / minutesInYear);
  rem %= minutesInYear;

  const months = Math.floor(rem / minutesInMonth);
  rem %= minutesInMonth;

  const days = Math.floor(rem / minutesInDay);
  rem %= minutesInDay;

  const hours = Math.floor(rem / minutesInHour);
  const minutes = rem % minutesInHour;

  const parts: string[] = [];

  if (years > 0) {
    parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
    if (months > 0) {
      parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
    }
    if (days > 0 && years < 2) {
      parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
    }
    return parts.join(' ');
  }

  if (months > 0) {
    parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
    if (days > 0) {
      parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
    }
    if (hours > 0 && months < 2) {
      parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
    }
    return parts.join(' ');
  }

  if (days > 0) {
    parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
    if (hours > 0) {
      parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
    }
    if (minutes > 0) {
      parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
    }
    return parts.join(' ');
  }

  if (hours > 0) {
    parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
    if (minutes > 0) {
      parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
    }
    return parts.join(' ');
  }

  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Formats dynamic elapsed duration for Spider stage time display:
 * A. Less than 1 hour (< 3600 seconds):
 *    - Show minutes only, spelled out: "X minute" / "X minutes"
 *    - e.g. "1 minute", "5 minutes", "35 minutes", "45 minutes"
 * B. 1 hour or more, but less than 1 day (>= 3600s and < 86400s):
 *    - Show hours + minutes using "min": "X hour(s) Y min" (or "X hour(s)" if 0 min)
 *    - e.g. "1 hour 10 min", "5 hours 25 min", "23 hours 45 min"
 * C. 1 day or more (>= 86400s):
 *    - Show days + hours only, ignoring minutes completely: "X day(s) Y hour(s)" (or "X day(s)" if 0 hr)
 *    - e.g. "1 day", "1 day 5 hours", "10 days 22 hours"
 * Seconds are never shown.
 */
export function formatSpiderDynamicStageDuration(totalSeconds: number): string {
  if (totalSeconds < 0) totalSeconds = 0;

  // C. 1 day or more
  const days = Math.floor(totalSeconds / 86400);
  if (days >= 1) {
    const remainingSeconds = totalSeconds % 86400;
    const hours = Math.floor(remainingSeconds / 3600);
    const dayStr = `${days} ${days === 1 ? 'day' : 'days'}`;
    if (hours > 0) {
      const hourStr = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
      return `${dayStr} ${hourStr}`;
    }
    return dayStr;
  }

  // B. 1 hour or more, but less than 1 day
  const hours = Math.floor(totalSeconds / 3600);
  if (hours >= 1) {
    const remainingSeconds = totalSeconds % 3600;
    const minutes = Math.floor(remainingSeconds / 60);
    const hourStr = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
    if (minutes > 0) {
      return `${hourStr} ${minutes} min`;
    }
    return hourStr;
  }

  // A. Less than 1 hour (< 3600 seconds)
  const minutes = Math.max(1, Math.floor(totalSeconds / 60));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Formats elapsed duration using standard Spider dynamic stage duration rules
 */
export function formatLargestUnitDuration(totalSeconds: number): string {
  return formatSpiderDynamicStageDuration(totalSeconds);
}

/**
 * Transforms any raw elapsed duration (such as "15773 Minutes ago" or "400 Hours ago")
 * within a notification message string into the dynamic formatted stage time format
 * (e.g. "10 days 22 hours ago", "5 hours 25 min ago", "35 minutes ago").
 */
export function formatNotificationMessageReadableTime(message?: string | null): string {
  if (!message) return '';

  return message.replace(
    /(\d+)\s*(Minutes?|Seconds?|Hours?|Days?|Weeks?|Months?|Years?)(\s+ago)?/gi,
    (match, valStr, unitStr, agoStr) => {
      const val = parseInt(valStr, 10);
      if (isNaN(val)) return match;

      const unitLower = unitStr.toLowerCase().replace(/s$/, '');
      let seconds = val;
      if (unitLower === 'second') seconds = val;
      else if (unitLower === 'minute') seconds = val * 60;
      else if (unitLower === 'hour') seconds = val * 3600;
      else if (unitLower === 'day') seconds = val * 86400;
      else if (unitLower === 'week') seconds = val * 7 * 86400;
      else if (unitLower === 'month') seconds = val * 30 * 86400;
      else if (unitLower === 'year') seconds = val * 365 * 86400;

      const readable = formatSpiderDynamicStageDuration(seconds);
      return agoStr ? `${readable} ago` : readable;
    }
  );
}

/** Format a timestamp into human-readable relative time (e.g., '6 days ago', '2 hours 15 minutes ago') */
export function formatLastCommunicationTimestamp(
  contactedAt?: string | Date | null
): string | null {
  if (!contactedAt) return null;
  const timeMs = new Date(contactedAt).getTime();
  if (isNaN(timeMs)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timeMs) / 1000));
  const readable = formatHumanReadableTimeSpan(elapsedSeconds);
  return `${readable} ago`;
}

/** Format lead communication status string (e.g. 'Last communication: 6 days ago') */
export function formatLeadLastCommunication(
  contactedAt?: string | Date | null,
  createdAt?: string | Date | null
): string {
  const commStr = formatLastCommunicationTimestamp(contactedAt);
  if (commStr) {
    return `Last communication: ${commStr}`;
  }
  const createdStr = formatLastCommunicationTimestamp(createdAt);
  if (createdStr) {
    return `No communication recorded yet (Lead created ${createdStr})`;
  }
  return 'No communication recorded yet';
}

/**
 * Resolves stage category for Spider alert messaging across the 3 pipeline stages:
 * 1. New lead has not been contacted
 * 2. Lead was contacted, but no walkthrough is scheduled
 * 3. Walkthrough completed, but estimate has not been sent
 */
export type SpiderStageCategory = 'new_lead' | 'contacted' | 'walkthrough';

export function getSpiderStageCategory(stageLabelOrId?: string): SpiderStageCategory {
  const s = (stageLabelOrId || '').toLowerCase().trim();

  // Stage 1: New -> Contacted / New
  if (s === 'new' || s.startsWith('new') || s.includes('new →') || s.includes('new-contacted')) {
    return 'new_lead';
  }

  // Stage 3: Walkthrough Completed -> Estimate / Walkthrough Completed / Estimate
  if (
    s === 'estimate' ||
    s.includes('estimate') ||
    s.includes('walkthrough-completed-estimate') ||
    s.includes('walkthrough-scheduled-estimate') ||
    s.includes('walkthrough completed') ||
    s.includes('walkthrough completed → estimate') ||
    s.includes('walkthrough scheduled → estimate')
  ) {
    return 'walkthrough';
  }

  // Stage 2: Contacted -> Walkthrough Scheduled / Contacted
  if (
    s === 'contacted' ||
    s.startsWith('contacted') ||
    s.includes('contacted →') ||
    s.includes('contacted-walkthrough-scheduled')
  ) {
    return 'contacted';
  }

  // Default fallback based on keywords
  if (s.includes('walkthrough')) {
    return 'walkthrough';
  }
  if (s.includes('contact')) {
    return 'contacted';
  }

  return 'new_lead';
}

/**
 * Action info based on lead stage for context-aware badges and notifications:
 * - New stage: "Need to contact"
 * - Contacted stage: "Schedule walkthrough"
 * - Walkthrough completed stage: "Send estimate"
 */
export function getSpiderStageAction(stageLabelOrId?: string): {
  label: string;
  stageKey: 'new' | 'contacted' | 'walkthrough_completed';
} {
  const stageCat = getSpiderStageCategory(stageLabelOrId);
  if (stageCat === 'walkthrough') {
    return {
      label: 'Send estimate',
      stageKey: 'walkthrough_completed',
    };
  }
  if (stageCat === 'contacted') {
    return {
      label: 'Schedule walkthrough',
      stageKey: 'contacted',
    };
  }
  return {
    label: 'Need to contact',
    stageKey: 'new',
  };
}

/**
 * Formats a clean elapsed time duration string (e.g. '10 days 22 hours 53 minutes', '2 hours 15 minutes', '20 minutes')
 */
export function formatElapsedDurationString(
  elapsedSeconds: number,
  elapsedValue?: number,
  elapsedUnit?: TimeUnit
): string {
  if (elapsedValue !== undefined && elapsedUnit) {
    const rawUnit = String(elapsedUnit).toLowerCase().replace(/s$/, '');
    let totalSecs = elapsedSeconds;
    if (rawUnit === 'minute') totalSecs = elapsedValue * 60;
    else if (rawUnit === 'hour') totalSecs = elapsedValue * 3600;
    else if (rawUnit === 'day') totalSecs = elapsedValue * 86400;
    else if (rawUnit === 'second') totalSecs = elapsedValue;
    return formatLargestUnitDuration(totalSecs);
  }
  return formatLargestUnitDuration(elapsedSeconds);
}

/**
 * Returns the exact stage-specific sentence matching the user requirements:
 * 1. New lead: "This lead was created [Time Since Created] ago and has not yet been contacted."
 * 2. Contacted: "This lead was contacted [Time Since Contact] ago, but a walkthrough has not yet been scheduled."
 * 3. Walkthrough: "The walkthrough was completed [Time Since Walkthrough] ago, but an estimate has not yet been sent."
 */
export function formatSpiderStageSentence(params: {
  assignedToName?: string | null;
  stageLabelOrId?: string;
  timeElapsedStr: string;
}): string {
  const stageCat = getSpiderStageCategory(params.stageLabelOrId);
  const cleanTime = (params.timeElapsedStr || '').replace(/\s+ago$/i, '').trim();

  if (stageCat === 'new_lead') {
    return `This lead was created ${cleanTime} ago and has not yet been contacted.`;
  } else if (stageCat === 'contacted') {
    return `This lead was contacted ${cleanTime} ago, but a walkthrough has not yet been scheduled.`;
  } else {
    return `The walkthrough was completed ${cleanTime} ago, but an estimate has not yet been sent.`;
  }
}

/**
 * Returns the complete Spider alert message format:
 * Spider Alert - [Lead Name] ([Lead ID])
 * [Stage-specific sentence]
 *
 * View lead: [Lead Link]
 */
export function formatFullSpiderAlertMessage(params: {
  customerName: string;
  leadNumber: string;
  assignedToName?: string | null;
  stageLabelOrId?: string;
  timeElapsedStr: string;
  leadId: string;
  baseUrl?: string;
}): string {
  const alertHeader = `Spider Alert - ${params.customerName} (${params.leadNumber})`;
  const sentence = formatSpiderStageSentence(params);
  const baseUrl = params.baseUrl || 'https://app.servwave.com';
  const leadUrl = `${baseUrl}/leads/${params.leadId}`;
  return `${alertHeader}\n${sentence}\n\nView lead: ${leadUrl}`;
}

/** Helper to format address components into a clean single-line address */
export function formatAddressParts(
  line1?: string | null,
  line2?: string | null,
  city?: string | null,
  state?: string | null,
  zip?: string | null
): string | null {
  const streetParts = [line1?.trim(), line2?.trim()].filter(Boolean);
  const street = streetParts.join(', ');
  const stateZip = [state?.trim(), zip?.trim()].filter(Boolean).join(' ');
  const cityStateZip = [city?.trim(), stateZip].filter(Boolean).join(', ');
  const fullParts = [street, cityStateZip].filter(Boolean);
  const full = fullParts.join(', ');
  return full.trim() || null;
}

/** Extract complete formatted service location string (street address, unit, city, state, zip) from lead data */
export function formatLeadServiceLocation(rawLead: any, rawCustomer?: any): string {
  if (!rawLead && !rawCustomer) return 'Service location not specified';

  // 1. Check nested service_location relation object with street address
  const loc = rawLead?.service_location || rawLead?.serviceLocation;
  if (loc && typeof loc === 'object') {
    const fromLoc = formatAddressParts(
      loc.address_line1,
      loc.address_line2,
      loc.city,
      loc.state,
      loc.zip
    );
    if (fromLoc && loc.address_line1) return fromLoc;
  }

  // 2. Check lead address scalars with street address
  const fromScalars = formatAddressParts(
    rawLead?.service_address_line1,
    rawLead?.service_address_line2,
    rawLead?.service_city,
    rawLead?.service_state,
    rawLead?.service_zip
  );
  if (fromScalars && rawLead?.service_address_line1) return fromScalars;

  // 3. Check customer service locations (from rawLead.customer or rawCustomer)
  const cust = rawLead?.customer || rawCustomer;
  const custLocs = cust?.service_locations || rawCustomer?.service_locations || rawLead?.customer_service_locations;
  if (Array.isArray(custLocs) && custLocs.length > 0) {
    // 3a. Matching service_location_id if present
    if (rawLead?.service_location_id) {
      const match = custLocs.find((l: any) => l.id === rawLead.service_location_id);
      if (match && match.address_line1) {
        const fromMatch = formatAddressParts(
          match.address_line1,
          match.address_line2,
          match.city,
          match.state,
          match.zip
        );
        if (fromMatch) return fromMatch;
      }
    }

    // 3b. Primary service location with street address
    const primary = custLocs.find((l: any) => l.is_primary) || custLocs[0];
    if (primary && primary.address_line1) {
      const fromPrimary = formatAddressParts(
        primary.address_line1,
        primary.address_line2,
        primary.city,
        primary.state,
        primary.zip
      );
      if (fromPrimary) return fromPrimary;
    }

    // 3c. Any location with address_line1
    for (const l of custLocs) {
      if (l && l.address_line1) {
        const fromAny = formatAddressParts(
          l.address_line1,
          l.address_line2,
          l.city,
          l.state,
          l.zip
        );
        if (fromAny) return fromAny;
      }
    }
  }

  // 4. Check customer billing address if street exists
  if (cust && typeof cust === 'object') {
    const fromBilling = formatAddressParts(
      cust.billing_address_line1,
      cust.billing_address_line2,
      cust.billing_city,
      cust.billing_state,
      cust.billing_zip
    );
    if (fromBilling && cust.billing_address_line1) return fromBilling;
  }

  // 5. If explicit serviceLocation string exists with complete street details (contains street numbers)
  if (typeof rawLead?.serviceLocation === 'string' && rawLead.serviceLocation.trim()) {
    const trimmed = rawLead.serviceLocation.trim();
    if (
      trimmed !== 'Service location not specified' &&
      trimmed !== 'No service location specified' &&
      /\d+/.test(trimmed)
    ) {
      return trimmed;
    }
  }

  // 6. Partial fallbacks if street address was not found anywhere
  if (loc && typeof loc === 'object') {
    const fromLoc = formatAddressParts(
      loc.address_line1,
      loc.address_line2,
      loc.city,
      loc.state,
      loc.zip
    );
    if (fromLoc) return fromLoc;
    if (loc.name) return loc.name;
  }
  if (fromScalars) return fromScalars;

  if (Array.isArray(custLocs) && custLocs.length > 0) {
    const primary = custLocs.find((l: any) => l.is_primary) || custLocs[0];
    if (primary) {
      const fromCustLoc = formatAddressParts(
        primary.address_line1,
        primary.address_line2,
        primary.city,
        primary.state,
        primary.zip
      );
      if (fromCustLoc) return fromCustLoc;
      if (primary.name) return primary.name;
    }
  }

  if (typeof rawLead?.serviceLocation === 'string' && rawLead.serviceLocation.trim()) {
    const trimmed = rawLead.serviceLocation.trim();
    if (trimmed !== 'Service location not specified' && trimmed !== 'No service location specified') {
      return trimmed;
    }
  }

  if (typeof rawLead?.service_location_name === 'string' && rawLead.service_location_name.trim()) {
    return rawLead.service_location_name.trim();
  }

  return 'Service location not specified';
}

/** Build customer + leads structure from live API records */
export function buildWatcherCustomersFromLive(
  apiLeads: any[] = [],
  apiCustomers: any[] = [],
  activatedAt?: string | Date | null
): WatcherCustomer[] {
  if ((!apiLeads || apiLeads.length === 0) && (!apiCustomers || apiCustomers.length === 0)) {
    return DEFAULT_WATCHER_CUSTOMERS;
  }

  const customerMap = new Map<string, WatcherCustomer>();

  // Map of full customer records for enriched location lookup
  const customersById = new Map<string, any>();
  if (Array.isArray(apiCustomers)) {
    for (const c of apiCustomers) {
      if (c && c.id) {
        customersById.set(c.id, c);
      }
    }
  }

  if (Array.isArray(apiLeads) && apiLeads.length > 0) {
    for (const rawLead of apiLeads) {
      // Restrict alerts to leads currently in New, Contacted, or Walkthrough Completed stages
      if (!isLeadInAllowedAlertStage(rawLead)) {
        continue;
      }

      const custId = rawLead.customer?.id || rawLead.customer_id || `cust-${rawLead.id}`;
      const matchedCustomer = customersById.get(custId) || rawLead.customer;
      const stageMetrics = resolveLeadStageAndElapsedTime(rawLead, activatedAt);
      const contactedTimestamp = rawLead.contacted_at || rawLead.contactedAt || null;

      const ownerObj =
        rawLead.commission_owner ||
        rawLead.assigned_to_user ||
        rawLead.owner ||
        (typeof rawLead.assigned_to === 'object' ? rawLead.assigned_to : null);

      const ownerId =
        rawLead.commission_owner_id ||
        (rawLead.commission_owner && typeof rawLead.commission_owner === 'object' ? rawLead.commission_owner.id : null) ||
        rawLead.assigned_to_user_id ||
        (rawLead.assigned_to_user && typeof rawLead.assigned_to_user === 'object' ? rawLead.assigned_to_user.id : null) ||
        rawLead.owner_id ||
        (typeof rawLead.assigned_to === 'string' ? rawLead.assigned_to : null) ||
        null;

      const ownerName = ownerObj
        ? `${ownerObj.first_name || ''} ${ownerObj.last_name || ''}`.trim() || ownerObj.name || ownerObj.email || null
        : null;

      const watcherLead: WatcherLead = {
        id: rawLead.id,
        leadNumber: rawLead.lead_number || `LD-${String(rawLead.id).slice(-4)}`,
        serviceRequest: rawLead.service_request || 'General Service Request',
        serviceLocation: formatLeadServiceLocation(rawLead, matchedCustomer),
        service_location_id: rawLead.service_location_id || null,
        service_location: rawLead.service_location || matchedCustomer?.service_locations?.[0] || null,
        service_address_line1: rawLead.service_address_line1 || null,
        service_address_line2: rawLead.service_address_line2 || null,
        service_city: rawLead.service_city || null,
        service_state: rawLead.service_state || null,
        service_zip: rawLead.service_zip || null,
        stageId: stageMetrics.stageId,
        stageLabel: stageMetrics.stageLabel,
        elapsedValue: stageMetrics.elapsedValue,
        elapsedUnit: stageMetrics.elapsedUnit,
        elapsedSeconds: stageMetrics.elapsedSeconds,
        createdAt: rawLead.created_at || rawLead.createdAt || (rawLead as any).created_date || (rawLead as any).created_at_utc || null,
        contactedAt: contactedTimestamp,
        walkthroughScheduledAt: rawLead.walkthrough_scheduled_at || rawLead.walkthroughScheduledAt || null,
        walkthroughCompletedAt: rawLead.walkthrough_completed_at || rawLead.walkthroughCompletedAt || null,
        status: rawLead.status,
        assigned_to: ownerId,
        assigned_to_user_id: ownerId,
        commission_owner_id: ownerId,
        commission_owner: ownerObj,
        assigned_to_user: ownerObj,
        owner: ownerObj,
        assignedToName: ownerName,
      };

      if (!customerMap.has(custId)) {
        const cust = matchedCustomer || rawLead.customer || {};
        customerMap.set(custId, {
          id: custId,
          name: customerDisplayName(cust, cust.company_name || 'Customer'),
          company: cust.company_name,
          email: cust.email,
          phone: cust.phone,
          service_locations: cust.service_locations || [],
          leads: [watcherLead],
        });
      } else {
        const existing = customerMap.get(custId)!;
        existing.leads.push(watcherLead);
        if (matchedCustomer) {
          if (existing.name === 'Customer' || !existing.email || !existing.company) {
            existing.name = customerDisplayName(matchedCustomer, matchedCustomer.company_name || existing.name);
            existing.company = matchedCustomer.company_name || existing.company;
            existing.email = matchedCustomer.email || existing.email;
            existing.phone = matchedCustomer.phone || existing.phone;
          }
          if ((!existing.service_locations || existing.service_locations.length === 0) && matchedCustomer.service_locations) {
            existing.service_locations = matchedCustomer.service_locations;
          }
        }
      }
    }
  }

  // Only return customers that contain leads in the 3 allowed stages
  const result = Array.from(customerMap.values()).filter((c) => c.leads && c.leads.length > 0);
  return result.length > 0 ? result : DEFAULT_WATCHER_CUSTOMERS;
}

/** Check if a lead was created during the current active Spider session (created at or after activatedAt, with 60s clock skew tolerance) */
export function isLeadCreatedDuringActiveSession(
  lead: Partial<WatcherLead> | Record<string, any>,
  activatedAt?: string | Date | null
): boolean {
  if (!activatedAt) return false;
  const actMs = new Date(activatedAt).getTime();
  if (isNaN(actMs)) return false;
  const rawCreated =
    lead.createdAt ||
    (lead as any).created_at ||
    (lead as any).created_date ||
    (lead as any).created_at_utc ||
    (lead as any).createdAtUtc;
  if (!rawCreated) return false;
  let createdMs = new Date(rawCreated).getTime();
  if (isNaN(createdMs) && typeof rawCreated === 'string') {
    createdMs = new Date(rawCreated.replace(' ', 'T')).getTime();
  }
  if (isNaN(createdMs)) return false;
  // Allow a 60-second grace window to account for server/client clock drift and network latency
  return createdMs >= (actMs - 60_000);
}

interface SpiderWatcherState {
  isActive: boolean;
  activatedAt: string | null;
  autoEnrollAllLeads: boolean;
  notifications: SpiderNotificationsConfig;
  assignments: SpiderAssignmentsConfig;
  days: string;
  leadStages: LeadStageConfig[];
  customers: WatcherCustomer[];
  selectedCustomerIds: string[];
  selectedLeadIds: string[];
  hasUserModifiedSelection: boolean;
  stageEnteredTimestamps: Record<string, string>;
  inAppNotifications: InAppNotification[];
  readNotificationIds: string[];
  isRedBorderActive: boolean;
  activeNotificationId: string | null;
  isWindowOpen: boolean;

  syncServerConfig: (config: {
    isActive?: boolean;
    autoEnrollAllLeads?: boolean;
    selectedLeadIds?: string[];
    stageThresholds?: Record<string, any>;
    notifications?: SpiderNotificationsConfig;
    assignments?: SpiderAssignmentsConfig;
    updatedAt?: string;
  }) => void;
  setIsActive: (active: boolean) => void;
  setActivatedAt: (activatedAt: string | null) => void;
  setAutoEnrollAllLeads: (autoEnroll: boolean) => void;
  toggleIsActive: () => void;
  /** Immediately deactivates Spider: sets isActive=false, activatedAt=null, zeros all stage thresholds */
  deactivateSpider: () => void;
  setNotifications: (
    updater:
      | SpiderNotificationsConfig
      | ((prev: SpiderNotificationsConfig) => SpiderNotificationsConfig)
  ) => void;
  setAssignments: (
    updater:
      | SpiderAssignmentsConfig
      | ((prev: SpiderAssignmentsConfig) => SpiderAssignmentsConfig)
  ) => void;
  setInAppNotification: (enabled: boolean) => void;
  setRedFrameNotification: (enabled: boolean) => void;
  setDays: (days: string) => void;
  setLeadStages: (stages: LeadStageConfig[]) => void;
  updateLeadStage: (id: string, updates: Partial<LeadStageConfig>) => void;
  setCustomers: (customers: WatcherCustomer[]) => void;
  recordLeadStageTransition: (leadId: string, stageId: string, timestamp?: string) => void;

  toggleCustomerSelection: (customerId: string, leadIdsForCustomer: string[]) => void;
  toggleLeadSelection: (
    leadId: string,
    customerId: string,
    allLeadIdsForCustomer: string[]
  ) => void;
  selectAllCustomers: () => void;
  deselectAllCustomers: () => void;

  markRead: (id: string) => void;
  markAllRead: () => void;
  markLeadNotificationsRead: (leadId: string, stageId?: string) => void;
  selectNotification: (id: string) => void;
  setIsRedBorderActive: (active: boolean) => void;
  setIsWindowOpen: (open: boolean) => void;
  toggleRedBorder: () => void;
  dispatchedAlertKeys: string[];
  dispatchOverdueAlerts: () => Promise<void>;
  resetStore?: () => void;

  getComputedNotifications: (user?: { id?: string; role?: string } | null) => InAppNotification[];
}

export const useSpiderWatcherStore = create<SpiderWatcherState>()(
  persist(
    (set, get) => ({
      isActive: false,
      activatedAt: null,
      autoEnrollAllLeads: true,
      notifications: {
        email: true,
        sms: true,
        inApp: true,
        redFrame: true,
      },
      assignments: DEFAULT_ASSIGNMENTS_CONFIG,
      days: '',
      leadStages: DEFAULT_LEAD_STAGES,
      customers: DEFAULT_WATCHER_CUSTOMERS,
      selectedCustomerIds: [],
      selectedLeadIds: [],
      hasUserModifiedSelection: false,
      stageEnteredTimestamps: {},
      inAppNotifications: [],
      readNotificationIds: [],
      isRedBorderActive: false,
      activeNotificationId: null,
      isWindowOpen: false,

      recordLeadStageTransition: (leadId, stageId, timestamp) =>
        set((state) => {
          const ts = timestamp || new Date().toISOString();
          return {
            stageEnteredTimestamps: {
              ...state.stageEnteredTimestamps,
              [`${leadId}:${stageId}`]: ts,
            },
          };
        }),

      setIsActive: (active) =>
        set((state) => {
          if (!active) {
            return {
              isActive: false,
              activatedAt: null,
              autoEnrollAllLeads: false,
              dispatchedAlertKeys: [],
              inAppNotifications: [],
              isRedBorderActive: false,
              leadStages: state.leadStages.map((s) => ({
                ...s,
                duration: undefined,
                enabled: false,
              })),
              notifications: {
                email: false,
                sms: false,
                inApp: false,
                redFrame: false,
              },
              assignments: {
                adminRoles: [],
                owner: false,
                users: [],
              },
              selectedCustomerIds: [],
              selectedLeadIds: [],
              hasUserModifiedSelection: true,
            };
          }
          return {
            isActive: true,
            activatedAt: state.activatedAt ?? new Date().toISOString(),
            autoEnrollAllLeads: true,
          };
        }),
      setActivatedAt: (activatedAt) => set({ activatedAt }),
      setAutoEnrollAllLeads: (autoEnrollAllLeads) => set({ autoEnrollAllLeads }),
      toggleIsActive: () =>
        set((state) => {
          const nextActive = !state.isActive;
          if (!nextActive) {
            return {
              isActive: false,
              activatedAt: null,
              autoEnrollAllLeads: false,
              dispatchedAlertKeys: [],
              inAppNotifications: [],
              isRedBorderActive: false,
              leadStages: state.leadStages.map((s) => ({
                ...s,
                duration: undefined,
                enabled: false,
              })),
              notifications: {
                email: false,
                sms: false,
                inApp: false,
                redFrame: false,
              },
              assignments: {
                adminRoles: [],
                owner: false,
                users: [],
              },
              selectedCustomerIds: [],
              selectedLeadIds: [],
              hasUserModifiedSelection: true,
            };
          }
          return {
            isActive: true,
            activatedAt: state.activatedAt ?? new Date().toISOString(),
            autoEnrollAllLeads: true,
          };
        }),
      deactivateSpider: () =>
        set((state) => ({
          isActive: false,
          activatedAt: null,
          autoEnrollAllLeads: false,
          dispatchedAlertKeys: [],
          inAppNotifications: [],
          isRedBorderActive: false,
          // Zero out all stage thresholds
          leadStages: state.leadStages.map((s) => ({
            ...s,
            duration: undefined,
            enabled: false,
          })),
          // Clear all notification channels
          notifications: {
            email: false,
            sms: false,
            inApp: false,
            redFrame: false,
          },
          // Clear all assignments
          assignments: {
            adminRoles: [],
            owner: false,
            users: [],
          },
          // Deselect all customers and leads
          selectedCustomerIds: [],
          selectedLeadIds: [],
          hasUserModifiedSelection: true,
        })),

      syncServerConfig: (config) =>
        set((state) => {
          const isServerActive = Boolean(config.isActive);
          if (!isServerActive) {
            return {
              isActive: false,
              activatedAt: null,
              autoEnrollAllLeads: config.autoEnrollAllLeads ?? false,
              dispatchedAlertKeys: [],
              inAppNotifications: [],
              isRedBorderActive: false,
              leadStages: state.leadStages.map((s) => ({
                ...s,
                duration: undefined,
                enabled: false,
              })),
              notifications: config.notifications
                ? { ...state.notifications, ...config.notifications }
                : {
                    email: false,
                    sms: false,
                    inApp: false,
                    redFrame: false,
                  },
              assignments: config.assignments
                ? normalizeAssignments(config.assignments)
                : {
                    adminRoles: [],
                    owner: false,
                    users: [],
                  },
              selectedCustomerIds: [],
              selectedLeadIds: config.selectedLeadIds ?? [],
              hasUserModifiedSelection: true,
            };
          }

          const updatedStages = state.leadStages.map((st) => {
            const serverVal = config.stageThresholds?.[st.id];
            if (serverVal !== undefined) {
              if (typeof serverVal === 'number') {
                return { ...st, duration: serverVal, enabled: serverVal > 0 };
              }
              if (typeof serverVal === 'object' && serverVal !== null) {
                const dur = serverVal.value ?? serverVal.duration ?? serverVal.days;
                return {
                  ...st,
                  duration: dur !== undefined ? Number(dur) : st.duration,
                  unit: serverVal.unit ?? st.unit,
                  enabled: serverVal.enabled ?? (dur !== undefined && Number(dur) > 0),
                };
              }
            }
            return st;
          });

          return {
            isActive: true,
            activatedAt: state.activatedAt ?? config.updatedAt ?? new Date().toISOString(),
            autoEnrollAllLeads: config.autoEnrollAllLeads ?? state.autoEnrollAllLeads,
            selectedLeadIds: config.selectedLeadIds ?? state.selectedLeadIds,
            notifications: config.notifications
              ? { ...state.notifications, ...config.notifications }
              : state.notifications,
            assignments: config.assignments
              ? normalizeAssignments(config.assignments)
              : state.assignments,
            leadStages: updatedStages,
          };
        }),

      setNotifications: (updater) =>
        set((state) => ({
          notifications: typeof updater === 'function' ? updater(state.notifications) : updater,
        })),

      setAssignments: (updater) =>
        set((state) => ({
          assignments: typeof updater === 'function' ? updater(state.assignments) : updater,
        })),

      setInAppNotification: (enabled) =>
        set((state) => ({
          notifications: { ...state.notifications, inApp: enabled },
        })),

      setRedFrameNotification: (enabled) =>
        set((state) => ({
          notifications: { ...state.notifications, redFrame: enabled },
        })),

      setDays: (days) => set({ days }),

      setLeadStages: (stages) => set({ leadStages: stages }),

      updateLeadStage: (id, updates) =>
        set((state) => {
          const updatedStages = state.leadStages.map((stage) =>
            stage.id === id ? { ...stage, ...updates } : stage
          );
          const firstStage = updatedStages[0];
          const newDays = firstStage && firstStage.duration !== undefined ? String(firstStage.duration) : '';
          return { leadStages: updatedStages, days: newDays };
        }),

      setCustomers: (customers) =>
        set((state) => {
          if (!customers || customers.length === 0) {
            return {
              customers: [],
              selectedCustomerIds: [],
              selectedLeadIds: [],
            };
          }
          const nowIso = new Date().toISOString();
          const allCustomerIds = customers.map((c) => c.id);
          const allLeadIds = customers.flatMap((c) => c.leads.map((l) => l.id));

          // Previous known lead IDs from last sync
          const previousKnownLeadIds = new Set(
            (state.customers || []).flatMap((c) => (c.leads || []).map((l) => l.id))
          );

          // Build a lookup of previous stages for existing leads
          const previousLeadStages = new Map<string, string>();
          for (const c of state.customers || []) {
            for (const l of c.leads || []) {
              const metrics = resolveLeadStageAndElapsedTime(l, state.activatedAt, state.stageEnteredTimestamps);
              previousLeadStages.set(l.id, metrics.stageId);
            }
          }

          const updatedStageTimestamps = { ...(state.stageEnteredTimestamps || {}) };

          // Check incoming leads for stage transitions
          for (const c of customers) {
            for (const l of c.leads || []) {
              const prevStage = previousLeadStages.get(l.id);
              const currentMetrics = resolveLeadStageAndElapsedTime(l, state.activatedAt, updatedStageTimestamps);
              const currentStage = currentMetrics.stageId;
              const stageKey = `${l.id}:${currentStage}`;

              // Determine explicit timestamp on the lead object if available
              let explicitTs: string | null = null;
              if (currentStage === 'new-contacted') {
                const raw = l.createdAt || (l as any).created_at;
                explicitTs = raw ? new Date(raw).toISOString() : null;
              } else if (currentStage === 'contacted-walkthrough-scheduled') {
                const raw = l.contactedAt || (l as any).contacted_at || (l as any).last_contact_at || (l as any).lastContactAt;
                explicitTs = raw ? new Date(raw).toISOString() : null;
              } else if (currentStage === 'walkthrough-completed-estimate') {
                const raw =
                  l.walkthroughCompletedAt ||
                  (l as any).walkthrough_completed_at ||
                  (l as any).walkthrough_first_completed_at ||
                  (l as any).walkthroughFirstCompletedAt ||
                  (l as any).last_visit_completed_at ||
                  (l as any).lastVisitCompletedAt;
                explicitTs = raw ? new Date(raw).toISOString() : null;
              }

              if (explicitTs) {
                updatedStageTimestamps[stageKey] = explicitTs;
              } else if (prevStage && prevStage !== currentStage) {
                // Lead transitioned to a new stage while Spider is active
                // Immediately start counting the new stage threshold timer from NOW
                updatedStageTimestamps[stageKey] = nowIso;
              } else if (!updatedStageTimestamps[stageKey]) {
                // Initial recording for this lead stage
                updatedStageTimestamps[stageKey] = state.activatedAt || nowIso;
              }
            }
          }

          // Retain currently selected IDs that still exist in the new dataset
          const existingSelectedCustomerIds = state.selectedCustomerIds.filter((id) =>
            allCustomerIds.includes(id)
          );
          const existingSelectedLeadIds = state.selectedLeadIds.filter((id) =>
            allLeadIds.includes(id)
          );

          // If Spider is deactivated, selection MUST remain empty unless explicitly selected
          if (!state.isActive || !state.activatedAt) {
            return {
              customers,
              stageEnteredTimestamps: updatedStageTimestamps,
              selectedCustomerIds: existingSelectedCustomerIds,
              selectedLeadIds: existingSelectedLeadIds,
            };
          }

          let updatedSelectedLeadIds = [...existingSelectedLeadIds];
          let updatedSelectedCustomerIds = [...existingSelectedCustomerIds];

          // Auto-enroll ONLY leads created during the active Spider session or newly arrived leads IF autoEnrollAllLeads is enabled
          if (state.isActive && state.activatedAt && state.autoEnrollAllLeads) {
            const newlyCreatedLeads = customers.flatMap((c) =>
              c.leads
                .filter((l) => {
                  const isCreatedDuring = isLeadCreatedDuringActiveSession(l, state.activatedAt);
                  const isNewArrival = previousKnownLeadIds.size > 0 && !previousKnownLeadIds.has(l.id);
                  return isCreatedDuring || isNewArrival;
                })
                .map((l) => ({ leadId: l.id, customerId: c.id }))
            );

            for (const { leadId, customerId } of newlyCreatedLeads) {
              if (!updatedSelectedLeadIds.includes(leadId)) {
                updatedSelectedLeadIds.push(leadId);
              }
              if (!updatedSelectedCustomerIds.includes(customerId)) {
                updatedSelectedCustomerIds.push(customerId);
              }
            }
          }

          return {
            customers,
            stageEnteredTimestamps: updatedStageTimestamps,
            selectedCustomerIds: updatedSelectedCustomerIds,
            selectedLeadIds: updatedSelectedLeadIds,
          };
        }),

      toggleCustomerSelection: (customerId, leadIdsForCustomer) =>
        set((state) => {
          const allLeadsSelected =
            leadIdsForCustomer.length > 0 &&
            leadIdsForCustomer.every((id) => state.selectedLeadIds.includes(id));
          const isSelected =
            state.selectedCustomerIds.includes(customerId) &&
            (leadIdsForCustomer.length === 0 || allLeadsSelected);

          let newCustomerIds: string[];
          let newLeadIds: string[];

          if (isSelected) {
            newCustomerIds = state.selectedCustomerIds.filter((id) => id !== customerId);
            newLeadIds = state.selectedLeadIds.filter((id) => !leadIdsForCustomer.includes(id));
          } else {
            newCustomerIds = Array.from(new Set([...state.selectedCustomerIds, customerId]));
            newLeadIds = Array.from(new Set([...state.selectedLeadIds, ...leadIdsForCustomer]));
          }

          return {
            hasUserModifiedSelection: true,
            selectedCustomerIds: newCustomerIds,
            selectedLeadIds: newLeadIds,
          };
        }),

      toggleLeadSelection: (leadId, customerId, allLeadIdsForCustomer) =>
        set((state) => {
          const isLeadSelected = state.selectedLeadIds.includes(leadId);
          let newLeadIds: string[];

          if (isLeadSelected) {
            newLeadIds = state.selectedLeadIds.filter((id) => id !== leadId);
          } else {
            newLeadIds = [...state.selectedLeadIds, leadId];
          }

          const hasAnySelectedLead = allLeadIdsForCustomer.some((id) => newLeadIds.includes(id));
          let newCustomerIds = state.selectedCustomerIds;

          if (hasAnySelectedLead && !state.selectedCustomerIds.includes(customerId)) {
            newCustomerIds = [...state.selectedCustomerIds, customerId];
          } else if (!hasAnySelectedLead && state.selectedCustomerIds.includes(customerId)) {
            newCustomerIds = state.selectedCustomerIds.filter((id) => id !== customerId);
          }

          return {
            hasUserModifiedSelection: true,
            selectedLeadIds: newLeadIds,
            selectedCustomerIds: newCustomerIds,
          };
        }),

      selectAllCustomers: () =>
        set((state) => ({
          hasUserModifiedSelection: true,
          selectedCustomerIds: state.customers.map((c) => c.id),
          selectedLeadIds: state.customers.flatMap((c) => c.leads.map((l) => l.id)),
        })),

      deselectAllCustomers: () =>
        set({
          hasUserModifiedSelection: true,
          selectedCustomerIds: [],
          selectedLeadIds: [],
        }),

      markRead: (id) =>
        set((state) => {
          const plainId = id.replace(/^notif-/, '');
          const fullNotifId = `notif-${plainId}`;
          return {
            readNotificationIds: Array.from(
              new Set([...state.readNotificationIds, id, fullNotifId, plainId])
            ),
          };
        }),

      markAllRead: () =>
        set((state) => {
          const allIds = get().getComputedNotifications().map((n) => n.id);
          const allPlainIds = allIds.map((id) => id.replace(/^notif-/, ''));
          return {
            readNotificationIds: Array.from(
              new Set([...state.readNotificationIds, ...allIds, ...allPlainIds])
            ),
          };
        }),

      markLeadNotificationsRead: (leadId, stageId) =>
        set((state) => {
          const plainId = String(leadId).replace(/^notif-/, '').trim();
          const newReadSet = new Set(state.readNotificationIds);

          let targetStageId = stageId;
          let targetLeadNumber: string | undefined;

          // If stageId not explicitly provided, find the lead's current stage
          for (const customer of state.customers || []) {
            for (const lead of customer.leads || []) {
              if (
                lead.id === leadId ||
                lead.id === plainId ||
                lead.leadNumber === leadId ||
                lead.leadNumber === plainId ||
                (lead.id && lead.id.toLowerCase() === plainId.toLowerCase()) ||
                (lead.leadNumber && lead.leadNumber.toLowerCase() === plainId.toLowerCase())
              ) {
                targetLeadNumber = lead.leadNumber;
                if (!targetStageId) {
                  const metrics = resolveLeadStageAndElapsedTime(lead, state.activatedAt);
                  targetStageId = metrics.stageId;
                }
                break;
              }
            }
            if (targetStageId) break;
          }

          if (targetStageId) {
            newReadSet.add(`notif-${plainId}-${targetStageId}`);
            newReadSet.add(`${plainId}:${targetStageId}`);
            if (targetLeadNumber) {
              newReadSet.add(`notif-${targetLeadNumber}-${targetStageId}`);
              newReadSet.add(`${targetLeadNumber}:${targetStageId}`);
            }
          } else {
            newReadSet.add(`notif-${plainId}`);
            newReadSet.add(plainId);
            newReadSet.add(`notif-${plainId}-new-contacted`);
            newReadSet.add(`notif-${plainId}-contacted-walkthrough-scheduled`);
            if (targetLeadNumber) {
              newReadSet.add(`notif-${targetLeadNumber}`);
              newReadSet.add(targetLeadNumber);
              newReadSet.add(`notif-${targetLeadNumber}-new-contacted`);
              newReadSet.add(`notif-${targetLeadNumber}-contacted-walkthrough-scheduled`);
            }
          }

          return {
            readNotificationIds: Array.from(newReadSet),
          };
        }),

      selectNotification: (id) =>
        set({
          activeNotificationId: id,
          isRedBorderActive: true,
        }),

      setIsRedBorderActive: (active) => set({ isRedBorderActive: active }),
      setIsWindowOpen: (open) => set({ isWindowOpen: open }),
      toggleRedBorder: () => set((state) => ({ isRedBorderActive: !state.isRedBorderActive })),
      clearRedBorder: () => set({ isRedBorderActive: false }),

      getComputedNotifications: (user) => {
        const state = get();
        const result: InAppNotification[] = [];

        if (!state.isActive || !state.activatedAt) {
          return result;
        }

        if (
          !state.customers ||
          state.customers.length === 0 ||
          !state.selectedLeadIds ||
          state.selectedLeadIds.length === 0
        ) {
          return result;
        }

        const assignments = state.assignments;
        const hasAdminRoles = Array.isArray(assignments?.adminRoles) && assignments.adminRoles.length > 0;
        const hasUsers = Array.isArray(assignments?.users) && assignments.users.length > 0;
        const hasOwner = !!assignments?.owner;

        // If nothing is selected in Admin role, User, or Owner, NO notifications are generated
        if (!hasAdminRoles && !hasUsers && !hasOwner) {
          return result;
        }

        for (const customer of state.customers) {
          if (!customer.leads || customer.leads.length === 0) continue;
          for (const lead of customer.leads) {
            // Strictly check whether this lead is selected
            const isSelected = state.selectedLeadIds.includes(lead.id);
            if (!isSelected) continue;

            // Check if user is an assigned recipient for this lead's notification
            const isAssigned = isUserAssignedToSpiderAlert(assignments, lead, user);
            if (!isAssigned) continue;

            const overdue = isLeadOverdue(lead, state.leadStages, state.isActive, state.activatedAt, state.stageEnteredTimestamps);
            const stageMetrics = resolveLeadStageAndElapsedTime(lead, state.activatedAt, state.stageEnteredTimestamps);
            const resolvedStageId = stageMetrics.stageId;
            const notifId = `notif-${lead.id}-${resolvedStageId}`;
            const legacyNotifId = `notif-${lead.id}`;

            // Stage-aware read check: dismissing/resolving a prior stage does NOT block alerts in subsequent stages
            const isRead =
              state.readNotificationIds.includes(notifId) ||
              state.readNotificationIds.includes(`${lead.id}:${resolvedStageId}`) ||
              Boolean(
                lead.leadNumber &&
                  (state.readNotificationIds.includes(`notif-${lead.leadNumber}-${resolvedStageId}`) ||
                    state.readNotificationIds.includes(`${lead.leadNumber}:${resolvedStageId}`))
              );

            if (overdue && !isRead) {
              const leadSecs = stageMetrics.elapsedSeconds;

              let timeAgoStr = `${stageMetrics.elapsedValue} ${stageMetrics.elapsedUnit}${stageMetrics.elapsedValue > 1 ? 's' : ''}`;
              if (leadSecs >= 86400) {
                timeAgoStr = `${Math.floor(leadSecs / 86400)}d ago`;
              } else if (leadSecs >= 3600) {
                timeAgoStr = `${Math.floor(leadSecs / 3600)}h ago`;
              } else if (leadSecs >= 60) {
                timeAgoStr = `${Math.floor(leadSecs / 60)}m ago`;
              } else {
                timeAgoStr = `${leadSecs}s ago`;
              }

              const stageName = formatCurrentStageName(lead.stageLabel || lead.stageId);
              const dynamicLocation = formatLeadServiceLocation(lead, customer);
              const resolvedLoc =
                dynamicLocation && dynamicLocation !== 'Service location not specified'
                  ? dynamicLocation
                : (lead.serviceLocation || 'Service location not specified');
              const lastCommMessage = formatLeadLastCommunication(lead.contactedAt, lead.createdAt);
              const assignedName = lead.assignedToName || getSpiderLeadOwnerName(lead) || 'Unassigned';

              // Total time the lead has spent in this stage (without activation timer truncation)
              const totalStageMetrics = resolveLeadStageAndElapsedTime(lead, undefined, state.stageEnteredTimestamps);
              const totalElapsedDurationStr = formatElapsedDurationString(
                totalStageMetrics.elapsedSeconds,
                totalStageMetrics.elapsedValue,
                totalStageMetrics.elapsedUnit
              );

              const stageSentence = formatSpiderStageSentence({
                assignedToName: assignedName,
                stageLabelOrId: lead.stageLabel || lead.stageId,
                timeElapsedStr: totalElapsedDurationStr,
              });

              result.push({
                id: notifId,
                contactName: customer.name,
                companyName: customer.company || customer.name,
                inactiveDays: Math.floor(leadSecs / 86400),
                message: stageSentence,
                timeAgo: timeAgoStr,
                read: false,
                contactId: customer.id,
                leadId: lead.id,
                leadNumber: lead.leadNumber,
                leadStage: stageName,
                serviceRequest: lead.serviceRequest,
                serviceLocation: resolvedLoc,
                contactedAt: lead.contactedAt || null,
                createdAt: lead.createdAt || null,
                stageEnteredAt: totalStageMetrics.stageEnteredAt || null,
                lastCommunication: lastCommMessage,
                isTriggered: true,
                assignedTo: assignedName,
                assignedToId: getSpiderLeadOwnerId(lead) || null,
              });
            }
          }
        }

        return result;
      },

      dispatchedAlertKeys: [],

      dispatchOverdueAlerts: async () => {
        // No-op: Alert evaluation and sweeps run on the server via scheduled cron sweeps (ARCH-1)
      },
      resetStore: () => {
        set({
          isActive: false,
          activatedAt: undefined,
          autoEnrollAllLeads: true,
          notifications: {
            email: true,
            sms: false,
            inApp: true,
            redFrame: true,
          },
          assignments: {
            adminRoles: ['ADMIN'],
            owner: true,
            users: [],
          },
          leadStages: DEFAULT_LEAD_STAGES,
          customers: [],
          selectedCustomerIds: [],
          selectedLeadIds: [],
          hasUserModifiedSelection: false,
          readNotificationIds: [],
          activeNotificationId: null,
          isRedBorderActive: false,
          stageEnteredTimestamps: {},
          dispatchedAlertKeys: [],
          days: '',
        });
      },
    }),
    {
      name: 'servwave_spider_watcher_settings',
      version: 8,
      migrate: (persistedState: any) => {
        // Clear deprecated stored customer and timer states on version bump
        return (persistedState || {}) as any;
      },
      partialize: (state) => ({
        // Note: isActive is authoritative from GET /api/ai-farm/spider/config (database)
        activatedAt: state.activatedAt,
        autoEnrollAllLeads: state.autoEnrollAllLeads,
        notifications: state.notifications,
        assignments: state.assignments,
        leadStages: state.leadStages,
        selectedLeadIds: state.selectedLeadIds,
        hasUserModifiedSelection: state.hasUserModifiedSelection,
        days: state.days,
        readNotificationIds: state.readNotificationIds,
        activeNotificationId: state.activeNotificationId,
        isRedBorderActive: state.isRedBorderActive,
      }),
    }
  )
);

// Register account-scoped store reset on logout (AIF-11)
registerStoreReset(() => {
  useSpiderWatcherStore.getState().resetStore?.();
});

/** Hook retained as no-op for backward compatibility (ARCH-1: alert engine runs on server) */
export function useSyncSpiderWatcherLive() {
  // Alert evaluation and sweeps are handled on the backend via scheduled server sweeps (ARCH-1)
}

