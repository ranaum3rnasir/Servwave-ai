/**
 * PDF IMAGE INSPECTOR — test-only structural verifier for rendered PDFs.
 *
 * Why this exists: `pdf-rendering-guard.test.ts` used to assert only that the generated
 * buffer starts with `%PDF`. That assertion is identical on a document whose logo was
 * silently dropped, so it could not detect a logo regression at all — a test that cannot
 * fail. See memory/a-test-that-cannot-fail-is-the-dominant-defect-class.md.
 *
 * Two claims are needed, because either one alone lets a regression through:
 *   1. PRESENT — an image XObject exists in the page's /Resources.
 *   2. DRAWN   — a content stream actually issues that XObject's `Do` operator.
 * An image can be embedded in /Resources and never painted; presence alone is the
 * weaker claim.
 *
 * HOW IT PARSES. The object/xref/stream layer is handled by `pdf-lib`, a real PDF
 * parser: it resolves indirect references and inflates the FlateDecode content streams
 * that pdfkit emits. We never regex the raw file bytes — pdfmake subsets its fonts and
 * compresses its streams, and naive zlib/substring extraction over those bytes has
 * produced false results on this repo in both directions (false "absent" AND false
 * "present"). On top of pdf-lib's *decoded* stream we run `scanContentStream`, a real
 * operator tokenizer that respects PDF lexical rules — it skips over literal `(...)`
 * strings, `<...>` hex strings, `%` comments and `BI…ID…EI` inline-image blobs, so a
 * byte sequence that merely looks like `/I1 Do` inside a string can never be counted
 * as a draw.
 *
 * SANITY ASSERTION. An extractor that silently returns nothing reports a clean pass on
 * every document, which is the same defect class we are fixing. So every report carries
 * positive evidence that the parse actually worked — page count, embedded font count,
 * decoded content length and whether text-showing operators are present. Every one of
 * those is known to be true of every PDF this app generates (they all draw text in Inter).
 * `assertPdfWasReadable` checks them, and callers run it BEFORE trusting an absence.
 */
import { PDFDocument, PDFDict, PDFName, PDFRawStream, PDFArray, decodePDFRawStream } from 'pdf-lib';
import { expect } from 'vitest';

export interface PdfImageReport {
  /** Number of pages the parser resolved. */
  pageCount: number;
  /** Names of image XObjects found in any page's /Resources (claim 1: PRESENT). */
  imageXObjects: string[];
  /** Names an actual `Do` operator paints in a content stream (claim 2: DRAWN). */
  drawnXObjects: string[];
  /** Image XObjects that are BOTH present in /Resources and painted by a `Do`. */
  drawnImages: string[];
  /** Embedded fonts across all pages — sanity evidence the resource dicts were read. */
  fontCount: number;
  /** Total decoded content-stream bytes — sanity evidence the streams inflated. */
  contentLength: number;
  /** Whether any text-showing operator (Tj/TJ/'/") ran — sanity evidence of a real page. */
  drawsText: boolean;
}

const WS = new Set([' ', '\n', '\r', '\t', '\f', '\0']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/**
 * Tokenize a decoded content stream at the PDF operator level and report which XObject
 * names are painted by `Do`, plus whether any text-showing operator ran.
 *
 * Operands precede their operator in PDF, so we remember the most recent /Name operand
 * and consume it when the `Do` operator arrives, clearing it at every operator boundary.
 */
export function scanContentStream(src: string): { drawn: string[]; drawsText: boolean } {
  const drawn: string[] = [];
  let drawsText = false;
  let lastName: string | null = null;
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (WS.has(c)) { i++; continue; }

    // Comment: runs to end of line.
    if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; continue; }

    // Literal string: balanced parens with backslash escapes. Contents are NOT tokens.
    if (c === '(') {
      let depth = 1; i++;
      while (i < src.length && depth > 0) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '(') depth++;
        else if (src[i] === ')') depth--;
        i++;
      }
      continue;
    }

    // `<<` dict open, or `<...>` hex string.
    if (c === '<') {
      if (src[i + 1] === '<') { i += 2; continue; }
      i++;
      while (i < src.length && src[i] !== '>') i++;
      i++;
      continue;
    }
    if (c === '>') { i += src[i + 1] === '>' ? 2 : 1; continue; }
    if (c === '[' || c === ']' || c === '{' || c === '}' || c === ')') { i++; continue; }

    // Name object: /Foo
    if (c === '/') {
      i++;
      const start = i;
      while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
      lastName = src.slice(start, i);
      continue;
    }

    // Bare token: a number, or an operator keyword.
    const start = i;
    while (i < src.length && !WS.has(src[i]) && !DELIM.has(src[i])) i++;
    const tok = src.slice(start, i);
    if (tok.length === 0) { i++; continue; }

    // Numeric operand — keeps any pending /Name operand alive (e.g. `/F1 12 Tf`).
    if (/^[+-]?[\d.]+$/.test(tok)) continue;

    // Inline image: `BI <dict> ID <raw bytes> EI`. The raw bytes are not tokens, so
    // skip to the EI keyword or we would lex binary garbage as operators.
    if (tok === 'BI') {
      const end = src.indexOf('EI', i);
      i = end === -1 ? src.length : end + 2;
      lastName = null;
      continue;
    }

    // An operator. Consume the pending operand and reset the operand state.
    if (tok === 'Do' && lastName) drawn.push(lastName);
    if (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"') drawsText = true;
    lastName = null;
  }

  return { drawn, drawsText };
}

/** Parse a rendered PDF and report what images it embeds and which of them it paints. */
export async function inspectPdfImages(buf: Buffer): Promise<PdfImageReport> {
  const doc = await PDFDocument.load(buf, { updateMetadata: false });

  const imageXObjects: string[] = [];
  const drawnXObjects: string[] = [];
  let fontCount = 0;
  let contentLength = 0;
  let drawsText = false;

  for (const page of doc.getPages()) {
    const resources = page.node.Resources();

    // Claim 1 — image XObjects present in /Resources.
    const xobjects = resources?.lookup(PDFName.of('XObject'));
    if (xobjects instanceof PDFDict) {
      for (const key of xobjects.keys()) {
        const stream = xobjects.lookup(key);
        const subtype = stream instanceof PDFRawStream ? stream.dict.lookup(PDFName.of('Subtype')) : null;
        if (subtype === PDFName.of('Image')) imageXObjects.push(String(key).replace(/^\//, ''));
      }
    }

    // Sanity evidence: embedded fonts.
    const fonts = resources?.lookup(PDFName.of('Font'));
    if (fonts instanceof PDFDict) fontCount += fonts.keys().length;

    // Claim 2 — decode the content streams and scan for the `Do` operator.
    const contents = page.node.context.lookup(page.node.get(PDFName.of('Contents')));
    const streams = contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.node.context.lookup(ref))
      : [contents];

    for (const stream of streams) {
      if (!(stream instanceof PDFRawStream)) continue;
      // latin1 is a 1:1 byte mapping, so operator scanning stays byte-exact.
      const decoded = Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1');
      contentLength += decoded.length;
      const scanned = scanContentStream(decoded);
      drawnXObjects.push(...scanned.drawn);
      if (scanned.drawsText) drawsText = true;
    }
  }

  return {
    pageCount: doc.getPageCount(),
    imageXObjects,
    drawnXObjects,
    drawnImages: imageXObjects.filter((n) => drawnXObjects.includes(n)),
    fontCount,
    contentLength,
    drawsText,
  };
}

/**
 * PER-FILE SANITY ASSERTION. Proves the extractor really read THIS document before any
 * caller is allowed to trust an absence. Without it, a parser that quietly returned an
 * empty report would mark every document — logo or not — as passing.
 */
export function assertPdfWasReadable(report: PdfImageReport, label: string): void {
  expect(report.pageCount, `${label}: parser resolved no pages — extractor is broken, not the PDF`).toBeGreaterThan(0);
  expect(report.contentLength, `${label}: no content stream inflated — extractor is broken, not the PDF`).toBeGreaterThan(0);
  expect(report.fontCount, `${label}: no embedded fonts found — extractor is broken, not the PDF`).toBeGreaterThan(0);
  expect(report.drawsText, `${label}: no text-showing operator found — extractor is broken, not the PDF`).toBe(true);
}

/** Assert the document embeds a logo image AND actually paints it. */
export async function expectLogoDrawn(buf: Buffer, label: string): Promise<PdfImageReport> {
  const report = await inspectPdfImages(buf);
  assertPdfWasReadable(report, label);
  expect(report.imageXObjects, `${label}: no image XObject in /Resources — the logo was never embedded`).not.toHaveLength(0);
  expect(report.drawnImages, `${label}: image XObject is embedded but no \`Do\` operator paints it`).not.toHaveLength(0);
  return report;
}

/**
 * Assert the document degraded to logo-less: no image embedded and nothing painted.
 * This is the negative control that proves `expectLogoDrawn` discriminates.
 */
export async function expectNoLogoDrawn(buf: Buffer, label: string): Promise<PdfImageReport> {
  const report = await inspectPdfImages(buf);
  assertPdfWasReadable(report, label);
  expect(report.imageXObjects, `${label}: expected a logo-less document but an image XObject is embedded`).toHaveLength(0);
  expect(report.drawnXObjects, `${label}: expected a logo-less document but an XObject is painted`).toHaveLength(0);
  return report;
}
