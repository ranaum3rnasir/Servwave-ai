/**
 * Where the bell of a reply from an address we did not send to points (PRD 10, S10.19): the Email page's Needs review item. The
 * Email page opens the held message named in `review`, and the server answers for it to anyone who can reach the conversation the
 * message replied to, whichever mailbox it is filed under (lib/communication/needsReview.ts).
 */
export const unmatchedReplyLink = (heldEmailId: string): string => `/communication/inbox?review=${encodeURIComponent(heldEmailId)}`;
