/**
 * True when a request failed because the record is not there (or is outside the viewer's scope):
 * the one failure that really means "not found". Every other failure - a dropped connection, a
 * timeout, a 5xx - says nothing about the record and must not be worded as if it did.
 */
export function isNotFoundError(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}

/**
 * True when the server refused the request outright (403): the person may not open this record. A record page shows
 * the "not authorized" screen for it; a 404 stays "not found" (the record is absent or outside the viewer's scope).
 */
export function isForbiddenError(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 403;
}

/**
 * React Query's `retry` for the read of a record's OWN page. The app retries a failed read once; for a refusal (403) that only
 * repeats the refusal, and each repeat is another failed request in the browser console. A refused record is asked for once.
 */
export function retryUnlessRefused(failureCount: number, error: unknown): boolean {
  return !isForbiddenError(error) && failureCount < 1;
}
