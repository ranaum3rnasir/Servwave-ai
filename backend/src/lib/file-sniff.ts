/**
 * Zero-dependency magic-byte content sniffing for the upload allowlists.
 *
 * Upload handlers must NOT trust the client-supplied multipart Content-Type
 * (multer derives `file.mimetype` straight from the attacker-controlled header).
 * This inspects the actual leading bytes and returns the detected MIME, or null
 * if the signature is unrecognised. Callers reject when the sniffed type is
 * absent or disagrees with the declared header (F-35).
 *
 * Covers exactly the three project allowlists:
 *   attachments:    image/jpeg, image/png, image/heic, image/heif,
 *                   video/mp4, video/quicktime, application/pdf,
 *                   OOXML + legacy Office documents, text/csv, text/plain
 *   org logos:      image/jpeg, image/png   (SVG intentionally NOT sniffable — F-36)
 *   staff avatars:  image/jpeg, image/png, image/webp
 *
 * Office documents are containers rather than distinct formats: every .docx/.xlsx/.pptx
 * is a ZIP and every legacy .doc/.xls/.ppt is an OLE2 compound document, so the leading
 * bytes can prove "this is a zip" but never "this is specifically a spreadsheet". They
 * are therefore sniffed to their CONTAINER type and matched by family, exactly as
 * HEIC/HEIF already are. Telling docx from xlsx would mean parsing the archive's
 * [Content_Types].xml, which buys nothing here: both are on the same allowlist, so a
 * mislabelled-but-genuine Office file is not a threat the check needs to catch.
 */
function bytesAt(buf: Buffer, offset: number, sig: number[]): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(buf: Buffer, offset: number, str: string): boolean {
  return bytesAt(buf, offset, Array.from(str, (c) => c.charCodeAt(0)));
}

export function sniffMime(buf: Buffer): string | null {
  // JPEG: FF D8 FF
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytesAt(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // PDF: %PDF
  if (ascii(buf, 0, '%PDF')) return 'application/pdf';
  // ZIP local-file / empty-archive / spanned headers: PK 03 04, PK 05 06, PK 07 08.
  // The OOXML carrier (docx/xlsx/pptx) — see the family note in the header comment.
  if (bytesAt(buf, 0, [0x50, 0x4b, 0x03, 0x04])
    || bytesAt(buf, 0, [0x50, 0x4b, 0x05, 0x06])
    || bytesAt(buf, 0, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  // OLE2 compound document: D0 CF 11 E0 A1 B1 1A E1 — legacy .doc/.xls/.ppt.
  if (bytesAt(buf, 0, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/x-ole-storage';
  // WEBP: RIFF container (bytes 0-3), size (4-7), 'WEBP' fourCC (8-11)
  if (ascii(buf, 0, 'RIFF') && ascii(buf, 8, 'WEBP')) return 'image/webp';
  // ISO-BMFF (mp4 / quicktime / heic): bytes 4-7 == 'ftyp', brand at 8-11
  if (ascii(buf, 4, 'ftyp')) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (brand === 'qt  ') return 'video/quicktime';
    if (brand === 'heic' || brand === 'heix' || brand === 'heif' || brand === 'mif1' || brand === 'msf1') {
      return brand === 'heif' || brand === 'msf1' ? 'image/heif' : 'image/heic';
    }
    // isom/mp41/mp42/iso2/avc1/dash/M4V … → treat as mp4
    return 'video/mp4';
  }
  return null;
}

/**
 * True when the sniffed bytes are consistent with the declared header against
 * the given allowlist. HEIC/HEIF and mp4/quicktime are treated as
 * interchangeable families so a legit photo declared image/heic but sniffed
 * image/heif (or vice-versa) is not falsely rejected.
 */
const FAMILIES: Record<string, string> = {
  'image/heic': 'heif-family', 'image/heif': 'heif-family',
  'video/mp4': 'mp4-family', 'video/quicktime': 'mp4-family',
  // OOXML: the sniffable container plus every declared type carried inside it.
  'application/zip': 'ooxml-family',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'ooxml-family',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'ooxml-family',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ooxml-family',
  // Legacy Office, same shape one container down.
  'application/x-ole-storage': 'ole-family',
  'application/msword': 'ole-family',
  'application/vnd.ms-excel': 'ole-family',
  'application/vnd.ms-powerpoint': 'ole-family',
};

/**
 * Types with no magic bytes to sniff. A signature check can only ever reject these, so
 * they are authenticated as text instead: no NUL bytes (the reliable binary tell) and a
 * clean UTF-8 decode. Weaker than a signature, and deliberately so - the alternative is
 * refusing every CSV a customer exports from their spreadsheet.
 */
const TEXT_TYPES = new Set(['text/csv', 'text/plain']);

function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  if (buf.includes(0x00)) return false;
  const head = buf.subarray(0, 8192);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  }
}

export function sniffMatchesDeclared(buf: Buffer, declared: string, allowed: readonly string[]): boolean {
  // The declared type gates first: a caller's allowlist is the authority on what may be
  // stored, and the family branch below trusts `declared` rather than the sniffed carrier.
  if (!allowed.includes(declared)) return false;
  // Text must ALSO carry no recognised binary signature. Absent that clause a ZIP whose
  // first bytes happen to be NUL-free ASCII ("PK..[Content_Types].xml") decodes cleanly
  // and would ride in labelled text/csv.
  if (TEXT_TYPES.has(declared)) return sniffMime(buf) === null && looksLikeText(buf);
  const sniffed = sniffMime(buf);
  if (!sniffed) return false;
  if (sniffed === declared) return allowed.includes(sniffed);
  return !!FAMILIES[sniffed] && FAMILIES[sniffed] === FAMILIES[declared];
}
