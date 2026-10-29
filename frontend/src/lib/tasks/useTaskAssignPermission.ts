import { useAppAbility } from '@/contexts/AbilityContext';
import { useAuthStore } from '@/stores/auth.store';

export interface TaskAssignPermission {
  /** May this user put a task on somebody other than themselves? */
  canAssignOthers: boolean;
  /** The signed-in user's id, or '' before the session hydrates. */
  actorId: string;
}

/**
 * Who this user is allowed to assign a task to.
 *
 * Reads the CASL ability the server ships with the session, NOT `user.role`. A
 * `role === 'ADMIN'` test is invisible to custom roles - which are in
 * production - and would both hide the control from a custom role that DOES
 * hold `assign` and offer it to nobody else, so the UI and the API would
 * disagree in both directions. `assign`/`Task` is the same pair the backend
 * gates POST and PATCH on (see the API contract), so what the field offers is
 * exactly what the server will accept.
 *
 * A non-holder still gets a task assigned to THEMSELVES - the server forces
 * `[actorId]` - so `actorId` comes back with the verdict; the create dialogs
 * pre-fill the disabled field with it rather than showing an empty control.
 */
export function useTaskAssignPermission(): TaskAssignPermission {
  const ability = useAppAbility();
  const actorId = useAuthStore((s) => s.user?.id) ?? '';
  return { canAssignOthers: ability.can('assign', 'Task'), actorId };
}
