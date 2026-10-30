/**
 * Spider's message texts: the in-app alert, the email and the text message, in the contractor's
 * words and order (Ran, 15 Oct: "exactly as it is"; his spiderDispatch.service.ts at 3bb6606).
 *
 * Changes to his code, none visible in the wording:
 *   - The lead number is shown as our lead page shows it (L00042). His `LD-` prefix was written for
 *     bare numbers and would read "LD-L00042" here.
 *   - "Assigned To" never falls back to a staff email address: a person with no name reads as
 *     "Unassigned" (staff addresses stay off every Spider screen and message).
 *   - The stage is our stage key (NEW / CONTACTED / WALKTHROUGH_COMPLETED); his matched it from a
 *     free-text label.
 *
 * Pure functions only: nothing here reads the database or sends anything.
 */
import { esc } from '../../lib/email';
import type { SpiderStatus } from './config';

/** His labels for the three stages ("Current Stage" in the email, the stage pill in the popup). */
export const SPIDER_STAGE_NAME: Record<SpiderStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  WALKTHROUGH_COMPLETED: 'Walkthrough Completed',
};

export interface SpiderMessageContent {
  leadNumber: string;
  customerName: string;
  stage: SpiderStatus;
  /** His `formatHumanReadableDuration` of the time in the stage. */
  timeInStage: string;
  /**
   * The duration the stage sentence reads, when it is not the time in the stage. Set for New only:
   * "This lead was created X ago" counts from the lead's creation, which for a lead moved back to New
   * (SPEC-4 D7) is longer than its fresh stay. Omitted, the sentence reads `timeInStage`.
   */
  sentenceTime?: string;
  assignedTo: string;
  serviceLocation: string;
  leadUrl: string;
}

/** His largest-whole-unit duration: "3 days", "1 hour", "5 minutes", never less than "1 minute". */
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

/** His stage sentence: the in-app body, the email callout and the second line of the text. */
export function spiderStageSentence(stage: SpiderStatus, timeInStageStr: string): string {
  if (stage === 'NEW') {
    return `This lead was created ${timeInStageStr} ago and has not yet been contacted.`;
  }
  if (stage === 'CONTACTED') {
    return `This lead was contacted ${timeInStageStr} ago, but a walkthrough has not yet been scheduled.`;
  }
  return `The walkthrough was completed ${timeInStageStr} ago, but an estimate has not yet been sent.`;
}

/** The in-app title and the email subject. */
export function spiderAlertHeader(c: Pick<SpiderMessageContent, 'customerName' | 'leadNumber'>): string {
  return `Spider Alert - ${c.customerName} (${c.leadNumber})`;
}

/** The email's plain-text body and the text message. */
export function spiderFullTextMessage(c: SpiderMessageContent): string {
  return `${spiderAlertHeader(c)}\n${spiderStageSentence(c.stage, c.sentenceTime ?? c.timeInStage)}\n\nView lead: ${c.leadUrl}`;
}

/**
 * His email body, every value escaped. It is the fragment his sender wrapped in the company's
 * branded layout; the caller wraps it the same way.
 */
export function spiderAlertEmailHtml(c: SpiderMessageContent, recipientFullName: string): string {
  const recipientName = recipientFullName.trim() || 'Team Member';
  const stageSentence = spiderStageSentence(c.stage, c.sentenceTime ?? c.timeInStage);
  const stageName = SPIDER_STAGE_NAME[c.stage];
  return `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1e293b;">
          <div style="background-color: #0c2d3a; padding: 18px 24px; border-radius: 8px 8px 0 0; text-align: left;">
            <span style="font-size: 13px; font-weight: 700; color: #f87171; text-transform: uppercase; letter-spacing: 0.5px;">🕷️ Spider AI Lead Watcher Alert</span>
            <h2 style="color: #ffffff; margin: 6px 0 0 0; font-size: 20px; font-weight: 600;">Spider Alert - ${esc(c.customerName)} (${esc(c.leadNumber)})</h2>
          </div>
          <div style="background-color: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            <p style="font-size: 15px; line-height: 1.5; margin-top: 0;">Hi ${esc(recipientName)},</p>
            <p style="font-size: 15px; line-height: 1.6; color: #1e293b; font-weight: 500; background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
              ${esc(stageSentence)}
            </p>

            <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; background-color: #f8fafc; border-radius: 6px; overflow: hidden;">
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; width: 35%; border-bottom: 1px solid #e2e8f0;">Lead Number:</td>
                <td style="padding: 10px 14px; color: #0f172a; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(c.leadNumber)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Customer:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(c.customerName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Assigned To:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(c.assignedTo)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Current Stage:</td>
                <td style="padding: 10px 14px; color: #dc2626; font-weight: 600; border-bottom: 1px solid #e2e8f0;">${esc(stageName)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0;">Time in Stage:</td>
                <td style="padding: 10px 14px; color: #0f172a; border-bottom: 1px solid #e2e8f0;">${esc(c.timeInStage)}</td>
              </tr>
              <tr>
                <td style="padding: 10px 14px; color: #64748b; font-weight: 600;">Service Location:</td>
                <td style="padding: 10px 14px; color: #0f172a;">${esc(c.serviceLocation)}</td>
              </tr>
            </table>

            <div style="text-align: center; margin-top: 25px; margin-bottom: 15px;">
              <a href="${esc(c.leadUrl)}" style="background-color: #0284c7; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
                View lead: ${esc(c.leadUrl)}
              </a>
            </div>
          </div>
        </div>
      `;
}

interface LocationParts {
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

/**
 * His service location: the lead's own service location, else the customer's primary location,
 * else their first, else "Service location on file". Parts joined with ", ". (His second fallback,
 * service-address columns on the lead itself, does not exist in our schema.)
 */
export function resolveServiceAddress(
  lead: { service_location: LocationParts | null },
  customer: { service_locations: (LocationParts & { is_primary: boolean })[] } | null,
): string {
  const joined = (loc: LocationParts) =>
    [loc.address_line1, loc.address_line2, loc.city, loc.state, loc.zip].filter(Boolean).join(', ');
  if (lead.service_location) {
    const parts = joined(lead.service_location);
    if (parts) return parts;
  }
  const primaryLoc = customer?.service_locations.find((l) => l.is_primary) ?? customer?.service_locations[0];
  if (primaryLoc) {
    const parts = joined(primaryLoc);
    if (parts) return parts;
  }
  return 'Service location on file';
}

interface PersonName {
  first_name: string | null;
  last_name: string | null;
}

/** His "Assigned To": the lead's first assignee, else its owner, else "Unassigned". */
export function spiderAssignedUserName(lead: {
  lead_assignees: { user: PersonName }[];
  commission_owner: PersonName | null;
}): string {
  const person = lead.lead_assignees[0]?.user ?? lead.commission_owner ?? null;
  if (!person) return 'Unassigned';
  return `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() || 'Unassigned';
}
