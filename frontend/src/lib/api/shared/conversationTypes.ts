import type { Message } from '@/lib/api/communication-shared';

/**
 * A send's answer. `threadId` is the conversation the text was filed in (#3023: a reply from a number no longer in use is
 * filed in the main-line conversation, which the screen then opens); `to` is the number it went to, which on a lead or a
 * job is the number the record shows (#3016), not always the one tapped.
 */
export type SendSmsResult = { message?: Message; threadId?: string; to?: string; delivery?: 'sent' | 'failed' | 'skipped' };

/**
 * What a text or email reassign answers. `left` is true when the change took the row out of the person's reach (it was
 * readable only through the job or lead it was taken off): the row is then null, the change is done, and the screen
 * lets it go quietly instead of reporting an error.
 */
export interface ConversationLinkResult {
  left?: boolean;
  /** A text's links as the server left them (#3024: a job pick also sets the text's lead to the job's own lead, or none). */
  message?: { leadId?: string; leadLabel?: string } | null;
}
