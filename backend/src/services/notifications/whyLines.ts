/**
 * whyLines.ts - the words of the why line (Roles & Permissions, PRD 6 M6).
 *
 * An alert that reached a person through a fallback step carries one line saying why it came to them. The chain
 * (alertChain.ts) and the senders that name their own stem (invoice and estimate alerts) build every such line here, so the
 * wording lives in one place and why-lines.test.ts pins it to the PRD text. PRD 6 gives each line a full stop.
 *
 * PRD 10's three reply reasons (emailReplyAlerts.ts) are quoted there without one and are kept as that PRD has them.
 */

/** A line's first words, with no full stop yet: the step 3 line adds to it before it ends. */
export type WhyStem = string;

/** "This job has no Dispatcher": step 2 reached the step's holders because the record had nobody to start from. */
export const noDispatcherStem = (record: string): WhyStem => `This ${record} has no Dispatcher`;
/** The Dispatcher was the person who made the change, so the alert is not theirs to be told of. */
export const dispatcherMadeChangeStem = (record: string): WhyStem => `This ${record}'s Dispatcher made this change`;
/** The Dispatcher is deactivated or cannot open the record. */
export const dispatcherUnavailableStem = (record: string): WhyStem => `This ${record}'s Dispatcher is not available`;

/** A standalone estimate has no people at all, so it starts at step 2. */
export const ESTIMATE_WITHOUT_LEAD_OR_JOB_STEM: WhyStem = 'This estimate has no lead or job';
/** A standalone invoice has no people at all, so it starts at step 2. */
export const INVOICE_WITHOUT_JOB_OR_LEAD_STEM: WhyStem = 'This invoice has no job or lead';

/** A line that ends at step 2. */
export const whyLine = (stem: WhyStem): string => `${stem}.`;
/** Step 3: nobody holding the step's switch could take it either ("...and nobody who can review jobs can open it."). */
export const nobodyCanOpenLine = (stem: WhyStem, step: string): string => `${stem} and nobody who can ${step} can open it.`;
/** A record-less alert (or Ready to close) that went straight to the Admins. */
export const nobodyCanLine = (step: string): string => `Nobody can ${step}.`;
/** Ready to close: closing is the step holders' own job, so only the last step explains itself. */
export const nobodyWhoCanOpenRecordLine = (step: string, record: string): string => `Nobody who can ${step} can open this ${record}.`;

/** PRD 8's reason line for a missed call, voicemail or text on a number nobody is linked to, word for word. */
export const NOBODY_LINKED_TO_NUMBER_REASON = 'Nobody is linked to this number and nobody sees every call and text.';

/** PRD 10's bell for a token reply whose sender does not match the person we wrote to, word for word. It opens the Needs review item. */
export const UNMATCHED_REPLY_MESSAGE = "A reply from an address we didn't send to - check and link it";
