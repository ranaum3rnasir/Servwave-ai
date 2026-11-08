/**
 * The frozen record of one version of an estimate document (#2030 slice 1).
 *
 * Sending has always written a snapshot — version, total, line items, scopes — but it has never
 * had a reader, and it held enough for a SUMMARY and not enough to re-render the document: no
 * photos, no branding, no addressee. This carries everything the document view-model consumes, so
 * a past version is rendered by the SAME code that renders the live one. A parallel read-only
 * renderer would drift, and the drift would be invisible until a customer asked about a document
 * nobody could reproduce.
 *
 * THERE ARE ALREADY THREE COMPETING CHANGE MECHANISMS on an estimate: clone-into-a-new-number
 * (revise), this snapshot, and send-back-to-draft-and-edit-in-place. The third is the one that
 * produced the estimate Ran reported. This adds no fourth — it gives the second one a reader.
 */
import {
  buildEstimateDocumentView,
  type EstimateDocumentView,
} from './estimate-document-view';

/** What a version needs to be re-rendered years later. */
export interface VersionSnapshotDocument {
  /** The document as it read, from the same view-model every live surface uses. */
  view: EstimateDocumentView;
  /** The branding as it stood at send time — an org that rebrands must not repaint history. */
  org: Record<string, unknown>;
  /** The template picked at send time, for the same reason. */
  templateKey: string;
  customer: Record<string, unknown> | null;
  serviceLocation: Record<string, unknown> | null;
  /**
   * The Storage paths behind this version's photos, so a renderer can re-sign them. Signed urls
   * expire within the hour and a version is meant to outlive that by years, so the snapshot
   * stores what can be re-signed rather than what was already signed.
   */
  photoPaths: string[];
}

/** The org fields the templates actually read. Copied verbatim so history cannot be repainted. */
const BRANDING_FIELDS = [
  'name', 'address_line1', 'address_line2', 'city', 'state', 'postal_code',
  'email', 'phone', 'website', 'logo_url', 'brand_color',
  'estimate_terms', 'estimate_notes', 'estimate_payment_terms',
] as const;

interface SnapshotSource {
  scope_photos?: Array<{ id: string; scope_id: string; url?: string | null; storage_path?: string | null; caption?: string | null }> | null;
  customer?: Record<string, unknown> | null;
  service_location?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export function buildVersionSnapshotDocument(
  estimate: SnapshotSource,
  org: Record<string, unknown>,
  templateKey: string,
): VersionSnapshotDocument {
  const view = buildEstimateDocumentView(estimate as never, org as never);

  // A photo is stored by PATH. `buildEstimateDocumentView` put the (already-signed, already
  // expiring) url on each row; swap it for the path so the version can be re-signed later.
  const pathById = new Map<string, string>();
  for (const photo of estimate.scope_photos ?? []) {
    if (photo.storage_path) pathById.set(photo.id, photo.storage_path);
  }
  const rows = view.rows.map((row) => ({
    ...row,
    photos: row.photos.map((photo) => ({ ...photo, url: pathById.get(photo.id) ?? '' })),
  }));

  const branding: Record<string, unknown> = {};
  for (const field of BRANDING_FIELDS) branding[field] = org[field] ?? null;

  return {
    view: { ...view, rows },
    org: branding,
    templateKey,
    customer: estimate.customer ?? null,
    serviceLocation: estimate.service_location ?? null,
    photoPaths: [...pathById.values()],
  };
}

/**
 * Every key path in a view, as a sorted list. Comparing paths — not values — is what lets a test
 * assert that the snapshot's SHAPE still matches the live view-model's, so a field added to the
 * view-model and forgotten here fails immediately rather than blanking on a version somebody
 * opens next year.
 */
export function snapshotDocumentPaths(view: unknown, prefix = ''): string[] {
  if (view === null || typeof view !== 'object') return [prefix];
  if (Array.isArray(view)) {
    // One element is enough to describe the shape; an empty array contributes the path itself.
    return view.length === 0 ? [`${prefix}[]`] : snapshotDocumentPaths(view[0], `${prefix}[]`);
  }
  return Object.entries(view as Record<string, unknown>)
    .flatMap(([key, value]) => snapshotDocumentPaths(value, prefix ? `${prefix}.${key}` : key))
    .sort();
}
