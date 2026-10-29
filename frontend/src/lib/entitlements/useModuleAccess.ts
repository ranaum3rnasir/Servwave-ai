import type { AppAction, AppSubject } from '@/lib/ability';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from './index';

/**
 * The two orthogonal axes a cross-module surface must pass before it renders:
 * the ORG bought the module (entitlement) AND this USER may use it (CASL).
 *
 * Use this - not a bare `ability.can(...)` - whenever a host surface embeds a
 * widget belonging to a DIFFERENT, higher-plan module. CASL alone is not enough:
 * `defineAbilityFor` short-circuits on role (`ADMIN → can('manage','all')`), so
 * every org's own admin passes every `can()` check regardless of what the org
 * pays for. A Pro org's admin therefore mounted Scale-only inventory widgets
 * inside the job command center, and the resulting 402 used to eject them to
 * /upgrade - inventory took jobs away, a module Pro actually includes.
 *
 * The policy: a module the org HAS is never restricted by one it does NOT.
 * Higher-plan widgets are HIDDEN on the host surface rather than mounted and
 * left to fail. The nav lock and <RequireFeature> stay the only places a user
 * is told to upgrade, because those are deliberate trips into the module itself.
 */
export function useModuleAccess(
  feature: string,
  action: AppAction,
  subject: AppSubject,
): boolean {
  const entitled = useFeature(feature);
  const ability = useAppAbility();
  return entitled && ability.can(action, subject);
}
