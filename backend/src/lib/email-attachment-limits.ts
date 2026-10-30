/**
 * The ceilings on the files an email carries, in ONE place: a person composing an email (routes/comm-email.routes.ts) and mail
 * we receive (lib/inbound-attachments.ts) are held to the same numbers, so a file one path would refuse never sits on the other.
 */
export const MAX_EMAIL_ATTACHMENTS = 10;
export const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
