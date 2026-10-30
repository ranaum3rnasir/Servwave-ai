import { Badge } from '@/ui-kit/components/ui/badge';

/**
 * "Deactivated" beside a person's name on a record (P19). Deactivating a person changes no record: their name stays on
 * every assignee, crew, Sold By, Owner and Dispatcher field, and this marks it so nobody mistakes the name for someone
 * still working here. Draws nothing for an active person, or when the record does not say (`is_active` left off).
 */
export function DeactivatedMark({ person }: { person: { is_active?: boolean } | null | undefined }) {
  if (!person || person.is_active !== false) return null;
  return (
    <Badge variant="softNeutral" size="sm" className="shrink-0">
      Deactivated
    </Badge>
  );
}
