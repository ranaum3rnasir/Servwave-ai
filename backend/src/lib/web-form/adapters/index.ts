import type { WebFormProvider } from '@prisma/client';
import type { WebFormSubmissionEvent } from '../types';
import { parseForminator } from './forminator';

export const WEB_FORM_PROVIDERS: ReadonlySet<string> = new Set<WebFormProvider>(['forminator']);

export function isWebFormProvider(v: string): v is WebFormProvider {
  return WEB_FORM_PROVIDERS.has(v);
}

/**
 * Parse a vendor body into the normalised submission event, or null when the
 * body is not a JSON object. `fieldMap` is the org's `field_map` column, layered
 * over the adapter's default map key by key; it is operator-entered JSON, so the
 * adapter validates it rather than trusting it.
 */
export function parseWebFormSubmission(
  provider: WebFormProvider,
  body: unknown,
  fieldMap?: unknown,
): WebFormSubmissionEvent | null {
  switch (provider) {
    case 'forminator':
      return parseForminator(body, fieldMap);
    default:
      return null;
  }
}
