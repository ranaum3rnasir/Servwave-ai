import { describe, it, expect } from 'vitest';
import { printer } from '../fonts';

describe('PdfPrinter initialization', () => {
  it('loads without errors', () => {
    expect(printer).toBeDefined();
  });

  it('can create a minimal document', async () => {
    const doc = await printer.createPdfKitDocument({
      content: [{ text: 'Hello', font: 'Inter' }],
      defaultStyle: { font: 'Inter' },
    });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', resolve);
      doc.on('error', reject);
      doc.end();
    });
    const pdfBuffer = Buffer.concat(chunks);
    expect(pdfBuffer.length).toBeGreaterThan(100);
    expect(pdfBuffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
