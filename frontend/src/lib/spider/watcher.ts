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
 *   - His browser-side lead list, its stage rules and its overdue maths are gone (#3436): the lead
 *     picker is answered by the server a page at a time, and the server alone decides what is overdue.
 */

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
