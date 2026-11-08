import https from 'https';
import http from 'http';
import { env } from '../../config/env';
import { logger } from '../logger';
import { printer } from './fonts';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { templateRegistry, invoiceTemplateRegistry, type TemplateKey } from './templates/registry';
import { type EstimateForPdf, type OrgForPdf, type InvoiceForPdf } from './templates/alpha-classic';
import { buildStatementPdf, type StatementForPdf, type StatementOrgForPdf } from './templates/statement';
import { buildEstimateDocumentView } from '../estimate-document-view';
import { documentImageRefs, resolveDocumentImages } from './document-images';
import { withRenderSlot } from './render-limit';

// Hard limits for the remote-logo fetch. The only legitimate source is the org's
// Supabase Storage public URL (set server-side from getPublicUrl), so we restrict
// to that host, cap bytes, forbid redirects, and time out fast. This removes the
// SSRF / unbounded-memory amplification (F-16): an attacker who can write
// organizations.logo_url (only reachable via the separate RC-1 data plane) can no
// longer make us GET internal metadata endpoints or stream us OOM.
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_MAX_BYTES = 2 * 1024 * 1024; // ~2MB

/** Host of the trusted Supabase project (e.g. "abc.supabase.co"). */
function allowedLogoHost(): string {
  return new URL(env.SUPABASE_URL).host;
}

export async function fetchAsBase64(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid logo URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Disallowed logo URL protocol: ${parsed.protocol}`);
  }
  if (parsed.host !== allowedLogoHost()) {
    throw new Error(`Disallowed logo host: ${parsed.host}`);
  }

  const client = parsed.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.get(url, (res) => {
      // Never follow redirects — a 3xx could bounce us off the allowlisted host.
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        reject(new Error(`Redirect not allowed for logo fetch (status ${status})`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (c: Buffer) => {
        total += c.length;
        if (total > FETCH_MAX_BYTES) {
          req.destroy(new Error('Logo exceeds maximum size'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const mime = res.headers['content-type'] ?? 'image/jpeg';
        resolve(`data:${mime};base64,${buf.toString('base64')}`);
      });
      res.on('error', reject);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error('Logo fetch timed out'));
    });
    req.on('error', reject);
  });
}

/**
 * Resolve an org's remote logo to an embeddable base64 data URI for pdfmake.
 *
 * A logo problem must NEVER fail the whole document. On any fetch error — a stale
 * host after a DB clone (organizations.logo_url points at a foreign Supabase project,
 * rejected by the F-16 allowlist), a timeout, an oversize file, an unsupported format —
 * we log a warning and render the PDF logo-less rather than 500ing the estimate /
 * invoice / statement. Non-http logo_url (null / already a data URI) passes through.
 */
async function embedLogo<T extends { logo_url?: string | null }>(org: T): Promise<T> {
  if (!org.logo_url?.startsWith('http')) return org;
  try {
    return { ...org, logo_url: await fetchAsBase64(org.logo_url) };
  } catch (err) {
    logger.warn(`PDF logo embed skipped (${org.logo_url}): ${(err as Error).message}`);
    return { ...org, logo_url: null };
  }
}

/** Shared by every generate*Pdf below: stream a pdfmake docDefinition to a Buffer. */
async function renderPdfBuffer(docDef: TDocumentDefinitions): Promise<Buffer> {
  const stream = await printer.createPdfKitDocument(docDef);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.end();
  });
}

export async function generateEstimatePdf(
  estimate: EstimateForPdf,
  org: OrgForPdf,
  templateKey: TemplateKey = 'alpha-classic',
): Promise<Buffer> {
  const builder = templateRegistry[templateKey];
  if (!builder) {
    throw new Error(`Unknown template key: ${templateKey}`);
  }

  // Pre-fetch remote logo so pdfmake (server-side, no URL resolver) can embed it.
  // Non-fatal: a bad logo degrades to a logo-less PDF, never a failed document.
  const resolvedOrg = await embedLogo(org);

  // #2029 — the document's images, fetched once each into a NAMED dictionary the templates
  // reference by key. Derived from the same view-model rows the public page renders, so the two
  // surfaces carry the same images. A fetch that fails leaves its key out and the renderer draws
  // nothing there — a broken photo never costs the customer their estimate.
  const view = buildEstimateDocumentView(estimate, org);
  const images = await resolveDocumentImages(documentImageRefs(view.rows), {
    fetchImage: fetchAsBase64,
  });

  return withRenderSlot(
    () => renderPdfBuffer(builder(estimate, resolvedOrg, images)),
    { imageCount: Object.keys(images).length, label: 'estimate' },
  );
}

/**
 * Invoice PDF. Mirrors generateEstimatePdf exactly — same logo embed, same template-key
 * lookup (the same picked template renders both documents) — against the invoice variant
 * of each template.
 */
export async function generateInvoicePdf(
  invoice: InvoiceForPdf,
  org: OrgForPdf,
  templateKey: TemplateKey = 'alpha-classic',
): Promise<Buffer> {
  const builder = invoiceTemplateRegistry[templateKey];
  if (!builder) {
    throw new Error(`Unknown template key: ${templateKey}`);
  }

  const resolvedOrg = await embedLogo(org);

  return renderPdfBuffer(builder(invoice, resolvedOrg));
}

/**
 * Statement PDF (entity-redesign §9). Mirrors generateEstimatePdf: pre-fetch the remote
 * logo, build the docDefinition via buildStatementPdf, render with the shared Inter printer.
 */
export async function generateStatementPdf(
  statement: StatementForPdf,
  org: StatementOrgForPdf,
): Promise<Buffer> {
  const resolvedOrg = await embedLogo(org);

  return renderPdfBuffer(buildStatementPdf(statement, resolvedOrg));
}

export type { EstimateForPdf, OrgForPdf, InvoiceForPdf, StatementForPdf, StatementOrgForPdf };
