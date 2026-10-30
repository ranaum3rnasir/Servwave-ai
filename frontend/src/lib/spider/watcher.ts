/* eslint-disable @typescript-eslint/no-explicit-any -- copied from the contractor's build as it is (Ran, 15 Oct). */
/**
 * Spider's Configuration tab maths and defaults, and the alert card's wording, copied from the
 * contractor's sandbox build (`frontend/src/stores/spiderWatcherStore.ts` at 3bb6606) as they are
 * (Ran, 15 Oct: "everything that Umer implemented ... exactly as it is"). Only the pure helpers the
 * Configuration tab and the alert popup use are here: nothing is stored in the browser, every
 * setting lives on the server (`/api/ai-farm/spider/settings`) and every alert comes from it
 * (`/api/ai-farm/spider/alerts/unread`).
 *
 * Changes to his code, each so the screen matches what the server does:
 *   - The stage ids are the server's stage keys (NEW, CONTACTED, WALKTHROUGH_COMPLETED); the labels
 *     are his.
 *   - A lead's stage and the instant it entered it come from `spiderStageOf`, the same rules the
 *     server's sweep uses (backend services/spider/config.ts) - his server's rules, with its two
 *     fixes - so the list shows exactly the leads the server watches. His browser-only rules
 *     (`isLeadInAllowedAlertStage`, the stage half of `resolveLeadStageAndElapsedTime`) differed
 *     from his own server's.
 */
import { customerDisplayName } from '@/lib/customer-name';

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
  // The lead's raw timestamps, kept so its stage can be decided by spiderStageOf (the server's rules).
  created_at?: string | null;
  contacted_at?: string | null;
  /** SPEC-4 D7: when the lead last moved back to New with no outbound contact left; its New stay starts here. */
  returned_to_new_at?: string | null;
  walkthrough_first_booked_at?: string | null;
  last_visit_completed_at?: string | null;
  first_estimate_sent_at?: string | null;
  won_at?: string | null;
  lost_at?: string | null;
  cancelled_at?: string | null;
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
 * The lead's Spider stage and the instant it entered it, or null when it is in none. The same rules
 * as the server's sweep (backend services/spider/config.ts spiderStageOf) - the contractor's server
 * rules (spiderWatcherCron.ts), with the two fixes listed there:
 *
 *   New                    no contacted_at, status New, no walkthrough booked or completed - from creation,
 *                          or from returned_to_new_at when the lead moved back to New (SPEC-4 D7)
 *   Contacted              status New or Contacted, with contacted_at or status Contacted, no
 *                          walkthrough booked or completed - from contacted_at, else creation
 *   Walkthrough Completed  last_visit_completed_at and no estimate sent - from last_visit_completed_at
 *
 * Won, Lost and Cancelled leads are in no stage, and a lead that reached Estimate is past New and
 * Contacted.
 */
export function spiderStageOf(lead: any): { stageId: string; stageLabel: string; enteredAt: string } | null {
  if (!lead) return null;
  const status = String(lead.status || '').toUpperCase().trim();
  if (status === 'WON' || status === 'LOST' || lead.won_at || lead.lost_at || lead.cancelled_at) return null;
  const pastEstimate = status === 'ESTIMATED' || Boolean(lead.first_estimate_sent_at);
  const noWalkthrough = !lead.walkthrough_first_booked_at && !lead.last_visit_completed_at;
  if (!lead.contacted_at && status === 'NEW' && noWalkthrough && !pastEstimate) {
    return { stageId: 'NEW', stageLabel: 'New → Contacted', enteredAt: lead.returned_to_new_at || lead.created_at };
  }
  const newOrContacted = status === 'NEW' || status === 'CONTACTED';
  if ((lead.contacted_at || status !== 'NEW') && newOrContacted && noWalkthrough && !pastEstimate) {
    return {
      stageId: 'CONTACTED',
      stageLabel: 'Contacted → Walkthrough Scheduled',
      enteredAt: lead.contacted_at || lead.created_at,
    };
  }
  if (lead.last_visit_completed_at && !lead.first_estimate_sent_at) {
    return {
      stageId: 'WALKTHROUGH_COMPLETED',
      stageLabel: 'Walkthrough Completed → Estimate',
      enteredAt: lead.last_visit_completed_at,
    };
  }
  return null;
}

/**
 * Whether a lead is in one of the 3 stages Spider acts on (his name for it). Reads the lead's raw
 * timestamps, kept on the WatcherLead by buildWatcherCustomersFromLive.
 */
export function isLeadInAllowedAlertStage(lead: any): boolean {
  return spiderStageOf(lead) !== null;
}

/**
 * Calculates the current stage and actual time spent in that stage from real lead timestamps.
 * When Spider activatedAt timestamp is provided, time is only measured forward from the moment of
 * activation. His maths; the stage and its start come from spiderStageOf.
 */
export function resolveLeadStageAndElapsedTime(
  lead: any,
  activatedAt?: string | Date | null
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
  const rawContactedAt = lead.contacted_at || lead.contactedAt;
  const visit = spiderStageOf(lead);
  const stageId = visit?.stageId ?? 'closed';
  const stageLabel = visit?.stageLabel ?? 'Closed';

  let stageStartTime: number = visit?.enteredAt ? new Date(visit.enteredAt).getTime() : now;
  if (isNaN(stageStartTime)) stageStartTime = now;

  // If activatedAt timestamp is provided and stage started before Spider was activated,
  // measure stage duration forward from activation
  if (activatedAt) {
    const actMs = new Date(activatedAt).getTime();
    if (!isNaN(actMs)) {
      stageStartTime = Math.max(stageStartTime, actMs);
    }
  }

  const elapsedMs = Math.max(0, now - stageStartTime);
  const elapsedSeconds = Math.floor(elapsedMs / 1000);

  let elapsedValue: number;
  let elapsedUnit: TimeUnit;

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
  activatedAt?: string | Date | null
): boolean {
  if (!isActive) {
    return false;
  }

  // Only consider leads in allowed stages for alerts
  if (!isLeadInAllowedAlertStage(lead)) {
    return false;
  }

  // Determine current stage & elapsed seconds from progression metrics
  const stageMetrics = resolveLeadStageAndElapsedTime(lead, activatedAt);
  const resolvedStageId = stageMetrics.stageId;
  const resolvedStageLabel = stageMetrics.stageLabel;
  // (His "Contacted, but a walkthrough is already scheduled" exception is left out: spiderStageOf
  // never puts a lead with a booked walkthrough in Contacted, which is the server's rule.)

  let leadSeconds = stageMetrics.elapsedSeconds;
  if (!lead.createdAt && !(lead as any).created_at && lead.elapsedSeconds !== undefined) {
    leadSeconds = lead.elapsedSeconds;
  }

  // The lead's own stage first: his loose matching below also matched a Contacted lead whose status
  // is still New to the New row, so it was measured against the wrong threshold.
  const config = stageConfigs.find((s) => s.id === resolvedStageId) ?? stageConfigs.find(
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
 * Provides a sensible default fallback duration when enabling a stage
 */
export function getDefaultFallbackDuration(stageId?: string, unit: TimeUnit = 'Minute'): number {
  return 1;
}

// Default 3 Lead Stages: New → Contacted, Contacted → Walkthrough Scheduled, Walkthrough Completed → Estimate
export const DEFAULT_LEAD_STAGES: LeadStageConfig[] = [
  {
    id: 'NEW',
    label: 'New → Contacted',
    fromStage: 'New',
    toStage: 'Contacted',
    duration: undefined,
    unit: 'Minute',
  },
  {
    id: 'CONTACTED',
    label: 'Contacted → Walkthrough Scheduled',
    fromStage: 'Contacted',
    toStage: 'Walkthrough Scheduled',
    duration: undefined,
    unit: 'Minute',
  },
  {
    id: 'WALKTHROUGH_COMPLETED',
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
        created_at: rawLead.created_at ?? null,
        contacted_at: rawLead.contacted_at ?? null,
        returned_to_new_at: rawLead.returned_to_new_at ?? null,
        walkthrough_first_booked_at: rawLead.walkthrough_first_booked_at ?? null,
        last_visit_completed_at: rawLead.last_visit_completed_at ?? null,
        first_estimate_sent_at: rawLead.first_estimate_sent_at ?? null,
        won_at: rawLead.won_at ?? null,
        lost_at: rawLead.lost_at ?? null,
        cancelled_at: rawLead.cancelled_at ?? null,
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

/**
 * The selected leads the save review lists (and counts as "{N} Leads Selected" / "Monitoring N
 * leads"): each selected lead the list shows in one of Spider's stages, then any other selected
 * lead the server named. The History tab's "{n} lead targets" uses the same list, so the two agree.
 */
export function selectedLeadsListOf(
  storeCustomers: readonly WatcherCustomer[] | undefined,
  selectedLeadIds: readonly string[] | undefined,
  selectedLeadLabels: Record<string, { lead_number: string; customer_name: string }> = {},
): Array<{ customer: Partial<WatcherCustomer>; lead: Partial<WatcherLead> & { id: string } }> {
  const list: Array<{ customer: Partial<WatcherCustomer>; lead: Partial<WatcherLead> & { id: string } }> = [];
  if (!selectedLeadIds || selectedLeadIds.length === 0) return list;

  const matchedIds = new Set<string>();
  if (storeCustomers) {
    for (const customer of storeCustomers) {
      if (!customer.leads) continue;
      for (const lead of customer.leads) {
        if (selectedLeadIds.includes(lead.id) && isLeadInAllowedAlertStage(lead)) {
          list.push({ customer, lead });
          matchedIds.add(lead.id);
        }
      }
    }
  }

  // Any selected lead not found in storeCustomers: named from the server, never invented.
  for (const leadId of selectedLeadIds) {
    const label = selectedLeadLabels[leadId];
    if (!matchedIds.has(leadId) && label) {
      list.push({
        customer: { name: label.customer_name },
        lead: { id: leadId, leadNumber: label.lead_number },
      });
    }
  }

  return list;
}
