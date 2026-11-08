import path from 'path';
import type { TFontDictionary } from 'pdfmake/interfaces';

// pdfmake ships its compiled server printer under js/Printer (not src/printer).
// The module uses __esModule + default export, so we destructure accordingly.
// A no-op urlResolver is required; without it resolveUrls() throws on local file paths.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PdfPrinter: new (
  fonts: TFontDictionary,
  virtualfs?: unknown,
  urlResolver?: { resolve: (url: string, headers: unknown) => void; resolved: () => Promise<void> },
) => { createPdfKitDocument: (docDef: unknown, options?: unknown) => Promise<import('stream').Readable & { end: () => void }> } =
  require('pdfmake/js/Printer').default;

const fontsDir = path.join(__dirname, 'fonts');

export const fonts: TFontDictionary = {
  Inter: {
    normal:      path.join(fontsDir, 'Inter-Regular.ttf'),
    bold:        path.join(fontsDir, 'Inter-Bold.ttf'),
    italics:     path.join(fontsDir, 'Inter-Italic.ttf'),
    bolditalics: path.join(fontsDir, 'Inter-BoldItalic.ttf'),
  },
};

// no-op urlResolver: fonts are local file paths, no HTTP resolution needed
const noopUrlResolver = { resolve: () => {}, resolved: () => Promise.resolve() };

export const printer = new PdfPrinter(fonts, undefined, noopUrlResolver);
