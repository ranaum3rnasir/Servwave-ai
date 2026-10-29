/**
 * Mobile slice 05 (PRD module 10, rubric CMP-14): the customer's signature is drawn into the
 * estimate PDF at the shape it was signed in.
 *
 * The public page's signature pad is now box x pixel ratio, so its image takes the pad's own
 * shape (about 302 x 160 on a 320 px phone, 638 x 160 on a desktop, times the pixel ratio). Both
 * templates used to force it into a 150 x 60 box with `width` AND `height`, which pdfmake obeys
 * literally: a phone signature came out stretched sideways and a desktop one squashed. `fit`
 * keeps the aspect ratio inside the same 150 x 60 slot.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';

const ORG = {
  id: '00000000-0000-0000-0000-000000000005',
  name: 'Sample Services Co',
  legal_name: null,
  address_line1: '1 Example Street',
  address_line2: null,
  city: 'Springfield', state: 'NJ', postal_code: '07000', country: 'US',
  email: 'office@example.com',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#336699',
  estimate_template: 'crm-default',
  estimate_terms: 'Sample terms.',
  estimate_notes: null,
  estimate_payment_terms: null,
};

const SIGNATURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const SIGNED = { ...PREVIEW_ESTIMATE_FIXTURE, signature_data: SIGNATURE, signature_at: new Date('2026-10-02T10:00:00Z') };

/** Every content node whose image is the signature. */
function signatureNodes(node: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) signatureNodes(child, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.image === SIGNATURE) out.push(o);
    for (const [k, v] of Object.entries(o)) if (k !== 'images') signatureNodes(v, out);
  }
  return out;
}

describe.each([
  ['alpha-classic', buildAlphaClassicPdf],
  ['crm-default', buildCrmDefaultPdf],
] as const)('%s estimate PDF - the signature keeps its shape', (_name, build) => {
  it('fits the signature in the 150 x 60 slot instead of stretching it to it', () => {
    const doc = build(SIGNED as any, ORG as any);
    const nodes = signatureNodes(doc.content);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.fit).toEqual([150, 60]);
    // width + height together is what stretches; neither may be set alongside fit.
    expect(nodes[0]!.width).toBeUndefined();
    expect(nodes[0]!.height).toBeUndefined();
  });
});
