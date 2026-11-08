import { useMemo } from 'react';

import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';
import type { KnownPerson } from '@/components/crm/knownPeople';

export interface AssignUserPermission {
  /** May this user put somebody OTHER than themselves on a record? */
  canAssignOthers: boolean;
  /** The signed-in user's id, or '' before the session hydrates. */
  actorId: string;
  /**
   * The signed-in user as a LABEL SOURCE, ready to concatenate into a picker's `knownPeople`.
   * Empty before the session hydrates; see the note below for why it exists at all.
   */
  actorKnownPeople: readonly KnownPerson[];
}

/**
 * Who this user is allowed to put on a walkthrough or a job crew.
 *
 * `assign User` - the PEOPLE-POOL grant. Deliberately NOT the same question as
 * `useTaskAssignPermission`, which reads `assign Task`: a holder of one may hold
 * neither the other, and `purpose='walkthroughPerformer'` / `'jobCrew'` are
 * scoped server-side by THIS grant (see `lib/api/users.ts` and
 * `listAssignable`). Reading the task hook here would offer a set the walkthrough
 * write validator then refuses with "You can only put yourself on a walkthrough."
 *
 * Reads the CASL ability the server ships with the session, NEVER `user.role`. A
 * `role === 'ADMIN' | 'DISPATCHER'` test is invisible to custom roles - which are
 * in production - so it would both hide the control from a custom role that DOES
 * hold `assign User` and offer it to a seeded role that does not, i.e. the UI and
 * the API would disagree in both directions. This is the property most likely to
 * be "simplified" into a role check later; it must not be.
 *
 * A non-holder is still a legal performer of their OWN walkthrough - the server
 * accepts exactly `[actorId]` from them - so the id comes back with the verdict,
 * and the form pre-fills the locked field with it rather than showing an empty
 * control behind a dead Schedule button.
 *
 * ── WHY THE NAME COMES BACK TOO (PRD story 15) ──────────────────────────────
 *
 * A seeded id has to render as a name, and on the seeding surfaces there is
 * nothing else that can supply it. `MultiAssigneeSelect` resolves a chip label
 * roster -> `knownPeople` -> the literal string `Unknown`, and in the seeding
 * case BOTH of the first two are empty:
 *
 *   - the roster is `useAssignableUsers`, whose `data` is `undefined` (so `[]`
 *     at every call site's default) for the whole of a cold load AND for ever if
 *     the request fails - `placeholderData: keepPreviousData` only helps when
 *     that query key already held something, which on a cold load it does not;
 *   - `knownPeople` is the RECORD's own people, and the seed fires precisely
 *     when the record names nobody.
 *
 * So a rep opening their lead saw a chip reading `Unknown` with "You can only
 * put yourself on a walkthrough." underneath it, correcting a few hundred ms
 * later - or never. The auth store already holds this user's name; handing it
 * back beside the id is what lets each seeding surface prepend it to its
 * `knownPeople`. It is a LABEL and nothing else: `knownPeople` adds nobody to
 * any dropdown and widens no write (see `components/crm/knownPeople.ts`).
 *
 * A cached payload with blank names is handled without a branch here -
 * `namesById` drops anyone `displayNameOf` cannot name, so the chip falls
 * through to `Unknown` exactly as it does today rather than rendering blank.
 *
 * All three halves are unhydrated-safe and flip together: `useAppAbility()`
 * defaults to `emptyAbility` (every `.can()` false, the safe direction) and
 * `user` is null, so a component that mounts before `establishSession` lands
 * reads `{ canAssignOthers: false, actorId: '', actorKnownPeople: [] }`.
 * `actorId` being `''` is legitimate - callers must keep an
 * `actorId ? [actorId] : []` guard rather than seeding `['']`, which the API
 * answers 400 "Performer not found or inactive".
 */
export function useAssignUserPermission(): AssignUserPermission {
  const ability = useAppAbility();
  const actorId = useAuthStore((s) => s.user?.id) ?? '';
  const firstName = useAuthStore((s) => s.user?.first_name) ?? null;
  const lastName = useAuthStore((s) => s.user?.last_name) ?? null;
  // Memoised on the three primitives rather than on the user object: a fresh array every render
  // would re-run `namesById` in every picker this is threaded into, on every render.
  const actorKnownPeople = useMemo<readonly KnownPerson[]>(
    () => (actorId ? [{ id: actorId, first_name: firstName, last_name: lastName }] : []),
    [actorId, firstName, lastName],
  );
  return { canAssignOthers: ability.can('assign', 'User'), actorId, actorKnownPeople };
}
