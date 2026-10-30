import { prisma } from './prisma';
import { logger } from './logger';
import { supabaseAdmin } from './supabase';
import { ATTACHMENTS_BUCKET, sanitizeAttachmentFilename } from './attachment-access';
import { sniffMatchesDeclared } from './file-sniff';
import { MAX_EMAIL_ATTACHMENTS, MAX_EMAIL_ATTACHMENT_BYTES } from './email-attachment-limits';
import { downloadReceivedAttachment, listReceivedAttachments, type ReceivedAttachmentRef } from './inbound-email';
// The compose path's own type allowlist, reused as it stands (a received file is held to the same list as a composed one).
import { ALLOWED_MIME_TYPES } from './attachment-types';

/**
 * Attachments on RECEIVED mail (PRD 10, S10.17), brought over from the mail provider and stored exactly the way a composed
 * email's attachments are: the same bucket, the same `{company}/email/{email}/` key, the same EmailAttachment row, the same
 * type allowlist, content check and per-file size and count ceilings (lib/email-attachment-limits.ts). The row is what the
 * existing attachment link (GET /api/communication/emails/:id/attachments/:index) signs, under the message's own reach rule.
 *
 * WHEN. Only after the router decided to keep the message, the message is stored and its write has committed: the webhook calls
 * this once it has answered (resend-webhook.controller.ts), so no provider or storage call is ever made inside a transaction or
 * while the provider waits on its acknowledgement, and a message the router drops never reaches here. The message shows from
 * the moment it is stored; its files follow.
 *
 * WHEN IT FAILS. The stored email carries `attachments_pending` (set in the write that stored it) and a count of the tries so
 * far. A try that cannot bring every file over leaves the flag set, logs the email's id (never a file name, sender or subject),
 * and the sweep below runs it again every few minutes until the files are all in or RECEIVED_ATTACHMENT_MAX_ATTEMPTS tries are
 * used up; after that the flag stays set, which is how a message that never got its files stays findable. The message itself is
 * never held back, hidden or deleted for it.
 *
 * WHAT IS NEVER RETRIED. A file the compose path would refuse (a type off the allowlist, bytes that do not match the type they
 * claim, over the per-file size, past the count) is skipped for good and logged by reason: no retry can change the answer. It
 * settles like a stored file, so it does not keep the flag set.
 *
 * ONCE. A file is stored once per email: the provider's attachment id is unique within its email (a unique index), so a retry,
 * a run that overlaps another, or a sweep racing the webhook cannot store it twice; a collision keeps the first row and removes
 * the object just written.
 */

/** Tries per message, the first (right after the message is stored) included. */
export const RECEIVED_ATTACHMENT_MAX_ATTEMPTS = 8;

/** A message younger than this is left to the webhook that stored it; the sweep only picks up what that run did not finish. */
const SWEEP_GRACE_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 50;

/** The id the provider knows a received message by: a further mailbox's copy carries its mailbox id after a `#`. */
const receivedIdOf = (providerMessageId: string) => providerMessageId.split('#')[0]!;

type Settled = 'stored' | 'skipped' | 'failed';

interface Target {
  id: string;
  organizationId: string;
}

/** Why a file the compose path would refuse is skipped, or null when it may be stored. Decided from what the provider reports. */
function refusalFor(ref: ReceivedAttachmentRef, index: number): string | null {
  if (index >= MAX_EMAIL_ATTACHMENTS) return 'past the number of files an email may carry';
  if (ref.size > MAX_EMAIL_ATTACHMENT_BYTES) return 'over the size limit';
  if (!ALLOWED_MIME_TYPES.includes(ref.content_type)) return 'type not allowed';
  return null;
}

/** Stores one downloaded file for one email. 'failed' leaves the email's flag set; anything else settles the file. */
async function storeFor(target: Target, ref: ReceivedAttachmentRef, index: number, bytes: Buffer): Promise<Settled> {
  const name = ref.filename?.trim() || 'attachment';
  const storagePath = `${target.organizationId}/email/${target.id}/${Date.now()}-${index}-${sanitizeAttachmentFilename(name)}`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(ATTACHMENTS_BUCKET)
    .upload(storagePath, bytes, { contentType: ref.content_type, upsert: false });
  if (uploadError) {
    logger.error(`[inbound-attachments] storing an attachment of email ${target.id} failed:`, uploadError);
    return 'failed';
  }
  try {
    await prisma.emailAttachment.create({
      data: {
        email_id: target.id,
        file_name: name,
        content_type: ref.content_type,
        file_size: bytes.length,
        storage_path: storagePath,
        position: index,
        provider_attachment_id: ref.id,
        organization_id: target.organizationId,
      },
      select: { id: true },
    });
    return 'stored';
  } catch (err) {
    // Another run stored this attachment first: its row stands and the object just written is surplus.
    if ((err as { code?: string }).code === 'P2002') {
      await supabaseAdmin.storage.from(ATTACHMENTS_BUCKET).remove([storagePath]).catch(() => undefined);
      return 'stored';
    }
    logger.error(`[inbound-attachments] linking an attachment to email ${target.id} failed:`, err);
    return 'failed';
  }
}

/** One received message and every stored copy of it (one per mailbox it reached): list once, download each file once. */
async function bringOverForMessage(receivedId: string, targets: Target[]): Promise<Set<string>> {
  const unfinished = new Set<string>();
  let refs: ReceivedAttachmentRef[];
  try {
    refs = await listReceivedAttachments(receivedId);
  } catch (err) {
    logger.error(`[inbound-attachments] listing the attachments of received message ${receivedId} failed:`, err);
    return new Set(targets.map((t) => t.id));
  }

  const already = await prisma.emailAttachment.findMany({
    where: { email_id: { in: targets.map((t) => t.id) } },
    select: { email_id: true, provider_attachment_id: true },
  });
  const stored = new Set(already.map((a) => `${a.email_id}:${a.provider_attachment_id}`));

  // File by file, so only one file's bytes are held at a time (a 25 MB photo ten times over is not a thing to keep in memory).
  for (const [index, ref] of refs.entries()) {
    const wanting = targets.filter((t) => !stored.has(`${t.id}:${ref.id}`));
    if (wanting.length === 0) continue;
    const refusal = refusalFor(ref, index);
    if (refusal) {
      logger.warn(`[inbound-attachments] attachment ${index} of received message ${receivedId} skipped: ${refusal}`);
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await downloadReceivedAttachment(ref, MAX_EMAIL_ATTACHMENT_BYTES);
    } catch (err) {
      logger.error(`[inbound-attachments] downloading attachment ${index} of received message ${receivedId} failed:`, err);
      for (const t of wanting) unfinished.add(t.id);
      continue;
    }
    // The bytes are what decides, not the type the sender's mail program wrote (the compose path's content check).
    if (bytes.length > MAX_EMAIL_ATTACHMENT_BYTES || !sniffMatchesDeclared(bytes, ref.content_type, ALLOWED_MIME_TYPES)) {
      logger.warn(`[inbound-attachments] attachment ${index} of received message ${receivedId} skipped: content does not match its type`);
      continue;
    }
    for (const target of wanting) {
      if ((await storeFor(target, ref, index, bytes)) === 'failed') unfinished.add(target.id);
    }
  }
  return unfinished;
}

/**
 * Brings over the attachments of these stored received emails that still have some on their way. Never throws: a failure is
 * logged by id and leaves the email pending for the sweep. Emails with nothing pending (or with their tries used up) are left
 * alone, so calling it for a message that has no attachments costs no statement beyond the one read.
 */
export async function bringOverReceivedAttachments(emailIds: string[]): Promise<void> {
  try {
    const due = await prisma.email.findMany({
      where: { id: { in: emailIds }, attachments_pending: true, attachment_attempts: { lt: RECEIVED_ATTACHMENT_MAX_ATTEMPTS } },
      select: { id: true, organization_id: true, provider_message_id: true, attachment_attempts: true },
    });
    if (due.length === 0) return;
    await prisma.email.updateMany({ where: { id: { in: due.map((e) => e.id) } }, data: { attachment_attempts: { increment: 1 } } });

    const byMessage = new Map<string, typeof due>();
    for (const email of due) {
      const key = receivedIdOf(email.provider_message_id ?? '');
      byMessage.set(key, [...(byMessage.get(key) ?? []), email]);
    }
    for (const [receivedId, emails] of byMessage) {
      const unfinished = await bringOverForMessage(receivedId, emails.map((e) => ({ id: e.id, organizationId: e.organization_id })));
      const finished = emails.filter((e) => !unfinished.has(e.id));
      if (finished.length > 0) {
        await prisma.email.updateMany({ where: { id: { in: finished.map((e) => e.id) } }, data: { attachments_pending: false } });
      }
      for (const email of emails.filter((e) => unfinished.has(e.id) && e.attachment_attempts + 1 >= RECEIVED_ATTACHMENT_MAX_ATTEMPTS)) {
        logger.error(`[inbound-attachments] gave up bringing over the attachments of email ${email.id} after ${RECEIVED_ATTACHMENT_MAX_ATTEMPTS} tries`);
      }
    }
  } catch (err) {
    logger.error('[inbound-attachments] bringing over received attachments failed:', err);
  }
}

let sweeping = false;

/**
 * The retry: received mail whose files are still on their way and whose first try is behind it, tried again. Cross-company
 * (the caller runs it unscoped). Never two overlapping runs in one process; never throws.
 */
export async function sweepReceivedAttachments(): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  try {
    const pending = await prisma.email.findMany({
      where: {
        attachments_pending: true,
        attachment_attempts: { lt: RECEIVED_ATTACHMENT_MAX_ATTEMPTS },
        created_at: { lt: new Date(Date.now() - SWEEP_GRACE_MS) },
      },
      select: { id: true },
      orderBy: { created_at: 'asc' },
      take: SWEEP_BATCH,
    });
    if (pending.length > 0) await bringOverReceivedAttachments(pending.map((e) => e.id));
    return pending.length;
  } catch (err) {
    logger.error('[inbound-attachments] sweep failed:', err);
    return 0;
  } finally {
    sweeping = false;
  }
}
