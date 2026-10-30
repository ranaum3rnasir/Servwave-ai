/**
 * Where the bell of a received email points (PRD 10): the conversation itself, in the mailbox it sits in. The Email page reads
 * `mailbox` as the mailbox to show (a mailbox the person may not open reads as their own, where the conversations they are
 * assigned or are one of the record's people for are listed too) and `thread` as the conversation to open. What the page lists
 * and opens is still the server's single-read rule, so the link gives a person no more than the screens do.
 */
export const conversationLink = (threadId: string, mailboxId: string | null): string => {
  const query = new URLSearchParams();
  if (mailboxId) query.set('mailbox', mailboxId);
  query.set('thread', threadId);
  return `/communication/inbox?${query.toString()}`;
};
