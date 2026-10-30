/* =============================================================================
   Payments go-live P10 - the pure rules of dispute evidence (lib/dispute-evidence.ts): the field whitelist,
   the size, page and character limits at their boundaries, the type and page checks on real bytes, the
   reason-to-recommended-fields map and the processor-error table.
   ========================================================================== */
import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  FILE_FIELDS, TEXT_FIELDS, LIMITS, isFileField, isTextField, inspectEvidenceBytes, checkTotals, recommendedFields,
  describeProcessorFailure, describeReason, textTotal, redactProcessorText,
} from '../lib/dispute-evidence';

async function pdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage();
  return Buffer.from(await doc.save());
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(20)]);

describe('field whitelist', () => {
  it('knows the seven file fields and five text fields and nothing else', () => {
    expect([...FILE_FIELDS]).toEqual(['receipt', 'customer_communication', 'customer_signature', 'service_documentation', 'cancellation_policy', 'refund_policy', 'uncategorized_file']);
    expect([...TEXT_FIELDS]).toEqual(['uncategorized_text', 'product_description', 'service_date', 'customer_name', 'customer_email_address']);
    expect(isFileField('receipt')).toBe(true);
    expect(isFileField('uncategorized_text')).toBe(false);
    expect(isTextField('uncategorized_text')).toBe(true);
    expect(isTextField('shipping_tracking_number')).toBe(false);
    expect(isFileField('__proto__')).toBe(false);
  });
});

describe('inspectEvidenceBytes (judged on the bytes)', () => {
  it('accepts a PDF and counts its pages', async () => {
    expect(await inspectEvidenceBytes(await pdfOf(3))).toEqual({ ok: true, mime: 'application/pdf', pages: 3 });
  });
  it('accepts a PNG and a JPEG as one page each', async () => {
    expect(await inspectEvidenceBytes(PNG)).toEqual({ ok: true, mime: 'image/png', pages: 1 });
    expect(await inspectEvidenceBytes(JPEG)).toEqual({ ok: true, mime: 'image/jpeg', pages: 1 });
  });
  it('refuses a HEIC photo and an Office file with the save-as-PDF message', async () => {
    const msg = 'Evidence must be a PDF, JPG or PNG. Save it as a PDF and attach that.';
    expect(await inspectEvidenceBytes(HEIC)).toEqual({ ok: false, error: msg });
    expect(await inspectEvidenceBytes(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]))).toEqual({ ok: false, error: msg });
    expect(await inspectEvidenceBytes(Buffer.from('just text'))).toEqual({ ok: false, error: msg });
  });
  it('refuses an unreadable PDF', async () => {
    expect(await inspectEvidenceBytes(Buffer.from('%PDF-1.4 this is not a pdf at all'))).toEqual({
      ok: false, error: "This PDF can't be read. Save it again as a PDF and attach that.",
    });
  });
  it('refuses an encrypted PDF', async () => {
    const encrypted = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n' +
      'trailer<</Root 1 0 R/Size 4/Encrypt<</Filter/Standard/V 1/R 2/O(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)/U(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)/P -4>>>>\n%%EOF',
    );
    expect(await inspectEvidenceBytes(encrypted)).toEqual({ ok: false, error: "This PDF can't be read. Save it again as a PDF and attach that." });
  });
});

describe('checkTotals boundaries', () => {
  const slot = (field: string, size_bytes: number, page_count = 1) => ({ field, size_bytes, page_count }) as never;
  const okInput = { slots: [slot('receipt', 1000)], text: { uncategorized_text: 'hello' }, cardBrand: 'visa' };

  it('has the processor limits', () => {
    expect(LIMITS).toMatchObject({ max_bytes: 4_500_000, max_pages: 49, max_pages_mastercard: 19, max_chars: 150_000, types: ['application/pdf', 'image/jpeg', 'image/png'] });
  });
  it('accepts exactly 4,500,000 bytes across all slots and refuses one more, naming the slot that crossed', () => {
    expect(checkTotals({ ...okInput, slots: [slot('receipt', 2_000_000), slot('customer_communication', 2_500_000)] })).toBeNull();
    expect(checkTotals({ ...okInput, slots: [slot('receipt', 2_000_000), slot('customer_communication', 2_500_001)] })).toMatchObject({ field: 'customer_communication' });
  });
  it('rounds the megabytes to the nearest tenth, never up past what the files are', () => {
    const r = checkTotals({ ...okInput, slots: [slot('receipt', 4_600_596)] });
    expect(r?.error).toBe('The files total 4.6 MB. The limit is 4.5 MB for all files together.');
  });
  it('accepts 49 pages and refuses 50', () => {
    expect(checkTotals({ ...okInput, slots: [slot('receipt', 10, 30), slot('refund_policy', 10, 19)] })).toBeNull();
    expect(checkTotals({ ...okInput, slots: [slot('receipt', 10, 30), slot('refund_policy', 10, 20)] })).toEqual({
      error: 'The files total 50 pages. The limit is 49 pages for all files together.', field: 'refund_policy',
    });
  });
  it('holds a Mastercard payment to 19 pages', () => {
    const mc = { ...okInput, cardBrand: 'mastercard' };
    expect(checkTotals({ ...mc, slots: [slot('receipt', 10, 19)] })).toBeNull();
    expect(checkTotals({ ...mc, slots: [slot('receipt', 10, 20)] })).toEqual({
      error: 'The files total 20 pages. The limit is 19 pages for a Mastercard payment.', field: 'receipt',
    });
    expect(checkTotals({ ...okInput, cardBrand: 'Mastercard', slots: [slot('receipt', 10, 20)] })).not.toBeNull();
  });
  it('accepts 150,000 characters of text across all fields and refuses 150,001', () => {
    const a = 'a'.repeat(100_000);
    expect(checkTotals({ ...okInput, text: { uncategorized_text: a, product_description: 'b'.repeat(50_000) } })).toBeNull();
    expect(checkTotals({ ...okInput, text: { uncategorized_text: a, product_description: 'b'.repeat(50_001) } })).toEqual({
      error: 'The text totals 150,001 characters. The limit is 150,000 for all text together.', field: 'product_description',
    });
    expect(textTotal({ uncategorized_text: 'abc', service_date: 'de' })).toBe(5);
  });
  it('allows one file per field only', () => {
    expect(checkTotals({ ...okInput, slots: [slot('receipt', 10), slot('receipt', 10)] })).toEqual({
      error: 'Each kind of document takes one file. Combine them into one PDF and attach that.', field: 'receipt',
    });
  });
});

describe('recommendedFields', () => {
  it('maps each reason code to the fields worth filling, always including the explanation', () => {
    expect(recommendedFields('product_not_received')).toEqual(expect.arrayContaining(['service_documentation', 'service_date', 'customer_communication']));
    expect(recommendedFields('credit_not_processed')).toEqual(expect.arrayContaining(['refund_policy']));
    expect(recommendedFields('subscription_canceled')).toEqual(expect.arrayContaining(['cancellation_policy']));
    expect(recommendedFields('fraudulent')).toEqual(expect.arrayContaining(['receipt', 'customer_signature', 'customer_name']));
    for (const reason of ['fraudulent', 'duplicate', 'general', 'weird_new_code', null]) {
      const r = recommendedFields(reason);
      expect(r).toContain('uncategorized_text');
      for (const f of r) expect(isFileField(f) || isTextField(f)).toBe(true);
    }
  });
  it('translates reason codes to words and never shows the code', () => {
    expect(describeReason('fraudulent')).toBe('The cardholder says they did not make this payment');
    expect(describeReason('weird_new_code')).toBe('The customer disputed this payment');
  });
});

describe('describeProcessorFailure', () => {
  const cases: Array<[unknown, string]> = [
    [{ code: 'file_too_large', message: 'File is too large' }, 'The file is too large'],
    [{ message: 'The file you uploaded exceeds the size limit' }, 'The file is too large'],
    [{ code: 'file_invalid_type' }, "The file type isn't accepted"],
    [{ message: 'Dispute evidence is past due' }, 'The deadline has passed'],
    [{ code: 'dispute_evidence_past_due' }, 'The deadline has passed'],
    [{ message: 'This dispute has already been submitted' }, 'Evidence was already submitted'],
    [{ message: 'Something du_123 odd on acct_999' }, "We couldn't send this to the card network. Try again in a moment, or contact ServWave support."],
    [new Error('boom'), "We couldn't send this to the card network. Try again in a moment, or contact ServWave support."],
    [undefined, "We couldn't send this to the card network. Try again in a moment, or contact ServWave support."],
  ];
  it.each(cases)('maps %j', (err, expected) => {
    expect(describeProcessorFailure(err)).toBe(expected);
  });
  it('never carries a vendor word, an id or the original text', () => {
    for (const [err] of cases) expect(describeProcessorFailure(err)).not.toMatch(/stripe|du_|acct_|file_|pi_|ch_/i);
  });
});

describe('redactProcessorText (the log keeps the processor words but not its ids)', () => {
  it('masks every id', () => {
    const out = redactProcessorText(Object.assign(new Error('No such file: file_1AbC for acct_9Zz on du_77 (pi_x1)'), { code: 'resource_missing' }));
    expect(out).toBe('[resource_missing] No such file: [id] for [id] on [id] ([id])');
  });
});
