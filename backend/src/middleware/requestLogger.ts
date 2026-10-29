import morgan from 'morgan';
import { redactUrl } from '../lib/log-redact';

/**
 * HTTP request logger.
 *
 * Replaces the default `morgan('dev')`, which logs the full request URL and so
 * leaks single-use secrets carried in the query string (invite tokens, OAuth
 * codes, OTPs, public-link signatures) into stdout / Render logs.
 *
 * `:url-safe` masks the value of any sensitive query param via `redactUrl`, and
 * the format deliberately emits NO request headers, so the `Authorization`
 * bearer token is never logged either.
 */
morgan.token('url-safe', (req) => {
  const r = req as { originalUrl?: string; url?: string };
  return redactUrl(r.originalUrl || r.url || '');
});

const FORMAT = ':method :url-safe :status :response-time ms - :res[content-length]';

export const requestLogger = morgan(FORMAT);
