/**
 * Minting one version of an estimate document (#2030 slices 1 and 2).
 *
 * A version records WHAT A CUSTOMER RECEIVED. So every event where a customer receives something
 * mints one — sending, marking as sent manually (an estimate delivered outside the system), and
 * copying the estimate to an invoice (which is what makes a payment reconcilable against what was
 * quoted). Only sending did. An ordinary edit mints nothing: editing is not a delivery.
 *
 * One function for all three, so a fourth trigger cannot arrive with a fourth idea of what a
 * version contains.
 *
 * TWO DIFFERENT NUMBERS, both spelled `version`, and they are not interchangeable:
 *
 *   - `estimates.version` counts MATERIAL EDITS to an already-sent estimate. Only
 *     `materialChangeGuardrail` moves it, and what it drives is the confirm-once-per-version
 *     prompt and the invalidated public token. A plain re-send does not move it at all.
 *   - `estimate_version_snapshots.version` counts DELIVERIES of this estimate: 1 is the first
 *     document the customer received, 2 the second, and so on. It is the ordinal that
 *     `/estimates/:id/versions/:version` addresses, so it has to be unique per estimate.
 *
 * Minting used to copy the first into the second. Two deliveries with no edit between them —
 * send then copy-to-invoice, or a plain re-send — therefore landed on the same number, which put
 * two identical version cards in the history drawer both pointing at one url. The ordinal is now
 * this table's own, counted here.
 */
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { prisma } from './prisma';
import { supabaseAdmin } from './supabase';
import { logger } from './logger';
import { estimateDocumentSelect, toEstimateDocument } from './estimate-document';
import { buildVersionSnapshotDocument } from './estimate-version-snapshot';

const BUCKET = 'attachments';

/** The customer-facing events that mint a version. */
export const VERSION_TRIGGERS = ['SEND', 'MARK_SENT', 'COPY_TO_INVOICE'] as const;
export type VersionTrigger = (typeof VERSION_TRIGGERS)[number];

export interface MintVersionInput {
  estimateId: string;
  orgId: string;
  trigger: VersionTrigger;
}

/**
 * Give the version its OWN copies of the photos. A version that pointed at the LIVE objects would
 * blank the moment a salesperson tidied up the estimate — and the whole point of a version is
 * that it still shows what the customer saw. Best-effort: a photo that will not copy is left out
 * rather than costing the version.
 *
 * Keyed by a per-mint id rather than by the version ordinal, so the copies can be made BEFORE the
 * transaction that assigns the ordinal opens. Holding a database transaction open across a
 * fan-out of Storage calls is how a connection pool gets exhausted, and a photo-heavy estimate
 * would hit the interactive-transaction timeout and mint nothing at all.
 */
async function freezePhotos(
  estimateId: string,
  mintId: string,
  orgId: string,
  photos: Array<{ id: string; storage_path?: string | null }>,
): Promise<Map<string, string>> {
  const frozen = new Map<string, string>();
  const storage = supabaseAdmin.storage.from(BUCKET);
  await Promise.all(
    photos.map(async (photo) => {
      if (!photo.storage_path) return;
      const filename = photo.storage_path.split('/').pop() ?? 'photo.jpg';
      const destination = `${orgId}/estimate_version/${estimateId}/${mintId}/${randomUUID()}-${filename}`;
      try {
        const { error } = await storage.copy(photo.storage_path, destination);
        if (error) {
          logger.warn(`Version photo not frozen (${photo.id}): ${error.message}`);
          return;
        }
        frozen.set(photo.id, destination);
      } catch (err) {
        logger.warn(`Version photo not frozen (${photo.id}): ${(err as Error).message}`);
      }
    }),
  );
  return frozen;
}

/**
 * Fire-and-forget by contract: supplementary history, never core transactional state. A snapshot
 * that cannot be written must not fail the send it followed — the customer already has the
 * document.
 */
export async function mintEstimateVersion({
  estimateId,
  orgId,
  trigger,
}: MintVersionInput): Promise<void> {
  try {
    const estimate = await prisma.estimate.findUnique({
      where: { id: estimateId },
      select: estimateDocumentSelect,
    });
    if (!estimate) return;

    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return;

    const frozen = await freezePhotos(estimateId, randomUUID(), orgId, estimate.scope_photos ?? []);

    // The document is built from the version's OWN photo paths, so it never points at a live
    // object that a later tidy-up could remove.
    const document = buildVersionSnapshotDocument(
      {
        ...toEstimateDocument(estimate),
        scope_photos: (estimate.scope_photos ?? []).map((p) => ({
          ...p,
          storage_path: frozen.get(p.id) ?? null,
        })),
      } as never,
      org as never,
      (org.estimate_template ?? 'alpha-classic') as string,
    );

    await prisma.$transaction(async (tx) => {
      // Read the high-water mark INSIDE the transaction that writes it. Resolving it before the
      // transaction opens is a snapshot, not a lock — a recorded incident in this repo — and the
      // callback form, never the array form, because a batch fires its writes eagerly and 500s
      // under DB_TENANT_GUARD.
      //
      // Org-scoped through the parent estimate: this table carries no organization_id of its own,
      // and the relation filter is what keeps the read inside the caller's tenant.
      const latest = await tx.estimateVersionSnapshot.findFirst({
        where: { estimate_id: estimateId, estimate: { organization_id: orgId } },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      await tx.estimateVersionSnapshot.create({
        data: {
          estimate_id: estimateId,
          // This estimate's next DELIVERY ordinal — see the two-numbers note at the top of the
          // file. Legacy rows minted before this fix can still share a number between them, which
          // is why the reader orders explicitly rather than trusting uniqueness.
          version: (latest?.version ?? 0) + 1,
          // The legacy summary columns stay populated: they predate `document` and something may
          // still read them.
          total_amount: estimate.total_amount,
          line_items: estimate.line_items as unknown as Prisma.InputJsonValue,
          scopes: estimate.scopes as unknown as Prisma.InputJsonValue,
          document: document as unknown as Prisma.InputJsonValue,
          trigger,
          sent_at: new Date(),
        },
      });
    });
  } catch (err) {
    logger.error('Failed to write estimate version snapshot:', err);
  }
}
