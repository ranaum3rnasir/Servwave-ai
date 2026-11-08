/**
 * Names for people who are ALREADY on a record, as opposed to people you may ADD to it.
 *
 * The two are different questions with different answers, and conflating them is the defect
 * this module exists to end. `GET /api/users/assignable` answers "who may I add", and it is
 * SCOPED: a salesperson without the `assign User` grant gets exactly one row - themselves.
 * That is the product rule, not a degraded response.
 *
 * But the rep who owns a lead owns its job, and may see everything about it - including, by
 * name, the technician a dispatcher put on their walkthrough. A one-row roster cannot supply
 * that name, so before this the chip rendered the literal string `Unknown`.
 *
 * It never had to. The names ride along on the record the surface already fetched -
 * `lead.walkthrough_performers[].user`, `visit.assignees[].user`, `job.assignees[].user`,
 * `task.assignees` - and were simply unused. A surface hands them in as `knownPeople`, and the
 * picker resolves a chip's label from the roster first and this second.
 *
 * Passing a name here NEVER widens who may be chosen. It is a label for an id the record
 * already holds; the roster remains the only source of addable candidates, and the server
 * re-derives the permitted set on every write regardless.
 */

/**
 * One person, in whichever of the two shapes the record that carries them happens to use.
 *
 * Deliberately BOTH rather than one canonical shape: task payloads carry `{ id, name }` and
 * the lead/job/visit payloads carry `{ id, first_name, last_name }`, so accepting both is what
 * lets every surface pass its payload straight through with no mapping step to get wrong. Every
 * field but `id` is optional and nullable, because these arrive from the API exactly as stored.
 */
export interface KnownPerson {
  id: string;
  /** A whole display name, as the task payloads carry it. */
  name?: string | null;
  /** ...or the two parts, as the lead/job/visit payloads carry them. */
  first_name?: string | null;
  last_name?: string | null;
}

/** The display name, or `null` when the person carries nothing worth rendering. */
export function displayNameOf(person: KnownPerson): string | null {
  const whole = person.name?.trim();
  if (whole) return whole;
  const parts = [person.first_name, person.last_name].filter((p): p is string => Boolean(p?.trim()));
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * id -> display name, skipping anyone who has no name to give.
 *
 * A person present but nameless is dropped rather than mapped to '', so the caller's fallback
 * chain reaches `Unknown` instead of rendering a blank chip - an unlabelled chip is worse than
 * an honestly labelled one.
 */
export function namesById(people: readonly KnownPerson[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const person of people ?? []) {
    const label = displayNameOf(person);
    if (label) map.set(person.id, label);
  }
  return map;
}
