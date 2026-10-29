import { formatInstant } from '@/lib/schedule-tz';

// Signature value object — what gets stamped onto a signed doc.
//
// In production these would persist to the server with the doc record
// (pickup ticket, PO, approval, etc.). For the prototype they are returned
// from <SignatureField> to the parent dialog, which holds them in local
// state until the doc is closed/exported.
//
// "Adopt" semantics mirror DocuSign: a signer types their full name once,
// the rendered script-font representation becomes their reusable signature,
// and subsequent docs offer one-tap "Apply my signature". The adopted name
// lives in localStorage under the signer's user id for the prototype — in
// production this lives on the user profile (signed signature image +
// adopted_at + IP / device). The <userId> is supplied by the caller from
// useAuthStore((s) => s.user?.id).

export type SignatureValue = {
  /** What the signer typed (or their saved adopted name). */
  fullName: string;
  /** ISO timestamp when the signature was applied to *this* doc. */
  signedAt: string;
  /** How it was applied. */
  method: "typed" | "auto_applied";
  /** Optional — for audit display. */
  signerId?: string;
};

export type SavedSignature = {
  fullName: string;
  adoptedAt: string;
};

const KEY = (userId: string) => `alpha:sig:${userId}`;

/** Returns the signer's adopted signature, or null if they have not adopted one. */
export function getSavedSignature(userId: string): SavedSignature | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSignature;
    if (!parsed.fullName) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist an adopted signature for re-use. */
export function saveSignature(userId: string, fullName: string): SavedSignature {
  const rec: SavedSignature = {
    fullName: fullName.trim(),
    adoptedAt: new Date().toISOString(),
  };
  if (typeof window !== "undefined") {
    window.localStorage.setItem(KEY(userId), JSON.stringify(rec));
  }
  return rec;
}

/** Forget the adopted signature (e.g. user clicks "Use a different signature"). */
export function clearSignature(userId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY(userId));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a typed signature into a self-contained SVG data URL.
 *
 * The PO stores its buyer signature as an IMAGE (`purchase_orders.signature_data`),
 * so a typed name is frozen into one at signing time: what prints later is what
 * was signed, independent of any future change to the script font or the
 * signer's display name. Fonts are declared by name only (a data-URL image loads
 * no web font), so the rendering falls back through the same cursive stack as
 * `.sig-script` in index.css.
 */
export function signatureImageDataUrl(fullName: string): string {
  const name = fullName.trim();
  const fontSize = 44;
  const width = Math.max(240, Math.round(name.length * fontSize * 0.5) + 32);
  const height = 84;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<text x="16" y="56" font-family="Caveat, 'Brush Script MT', 'Lucida Handwriting', cursive" ` +
    `font-size="${fontSize}" font-weight="700" font-style="italic" fill="black">${escapeXml(name)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Helper: render a date in a doc-friendly format ("May 26, 2026 · 2:14 PM").
 *
 *  On the ORG's clock, not the signer's. This matters more here than on a normal
 *  render: ApprovalDetailDialog splices the result into the approval COMMENT it
 *  persists, so a browser-zone reading is not merely shown wrong to one viewer -
 *  it is written into the record permanently, and every later reader inherits the
 *  approver's timezone with no way to tell. */
export function fmtSignedAt(iso: string, tz: string): string {
  const date = formatInstant(iso, tz, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = formatInstant(iso, tz, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
