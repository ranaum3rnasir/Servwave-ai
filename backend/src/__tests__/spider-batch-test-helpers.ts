/**
 * Test helper for the Spider email tests (#3470). Spider sends one alert's emails as ONE batch request. Several
 * older Spider tests fake the provider one email at a time (`resendSend(message)` answers one person); this turns
 * that per-person fake into the batch call's answer, in the provider's permissive shape: the accepted emails' ids in
 * order, and an `errors` entry (by index) for each one it refused. Every message still passes through `send`, so the
 * tests that read what was sent keep working.
 */

type OneMessage = Record<string, unknown>;
type OneAnswer = { data: { id: string } | null; error: { name?: string; message?: string; statusCode?: number | null } | null };

export function batchOverSingleSends(send: (message: OneMessage) => Promise<OneAnswer>) {
  return async (payload: OneMessage[], _options?: unknown) => {
    const answers: OneAnswer[] = [];
    for (const message of payload) {
      try {
        answers.push(await send(message));
      } catch {
        answers.push({ data: null, error: { name: 'application_error', message: 'refused' } });
      }
    }
    const errors = answers.flatMap((a, index) => (a.error || !a.data ? [{ index, message: 'refused' }] : []));
    const data = answers.flatMap((a) => (a.error || !a.data ? [] : [{ id: a.data.id }]));
    return { data: { data, errors }, error: null };
  };
}
