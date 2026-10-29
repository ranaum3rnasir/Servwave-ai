import { extractApiError } from '@/lib/utils';

/**
 * A failed Spider save as the sentences the server wrote. Every Spider rule names its own problem
 * in words ("Limit can be at most one year"), so the field the server keyed it to is internal and
 * never shown. A problem with one
 * status's limit ("status_limits.NEW.value") is named by that status's own label ("New: ..."),
 * never by the path. Details with no words at all read as `fallback`.
 *
 * Shared by the settings form on the Spider page and the on/off switch in the AI Agentic Farm.
 */
export function spiderErrorText(
  err: unknown,
  fallback: string,
  statusLabels: Record<string, string> = {},
): string {
  const details = (err as { response?: { data?: { details?: Array<{ field?: string; message?: string }> } } })
    ?.response?.data?.details;
  if (!details?.length) return extractApiError(err, fallback);
  const sentences = details
    .map((d) => {
      const message = d.message?.trim().replace(/\.$/, '');
      if (!message) return null;
      const status = /^status_limits\.([^.]+)/.exec(d.field ?? '')?.[1];
      const label = status ? statusLabels[status] : undefined;
      return label ? `${label}: ${message}` : message;
    })
    .filter((m): m is string => !!m);
  return sentences.length ? sentences.join('. ') : fallback;
}
