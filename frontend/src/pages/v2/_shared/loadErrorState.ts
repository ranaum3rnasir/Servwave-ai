/**
 * True when a request failed because the record is not there (or is outside the viewer's scope):
 * the one failure that really means "not found". Every other failure - a dropped connection, a
 * timeout, a 5xx - says nothing about the record and must not be worded as if it did.
 */
export function isNotFoundError(error: unknown): boolean {
  return (error as { response?: { status?: number } } | null)?.response?.status === 404;
}
