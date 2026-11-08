/**
 * Module 12 - Communication.
 *
 * LEGACY paths, without the `/v2` prefix. React is never imported here: this
 * file is read by `uiV2.ts`, which every v2 page imports, so a React import
 * would close an import cycle. See `routes/README.md`.
 *
 * `/phone` belongs to this module even though it does not sit under
 * `/communication`: it is the dedicated softphone tab, the module's only
 * device-owning surface, and no other module could register it.
 */
export const COMMUNICATION_V2_PATHS = [
  '/communication/inbox',
  '/communication/phone',
  '/communication/phone/:tab',
  '/communication/whatsapp',
  '/communication/text',
  '/communication/text/:tab',
  '/phone',
] as const;
