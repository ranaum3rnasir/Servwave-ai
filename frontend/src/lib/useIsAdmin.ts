import { useAuthStore } from '@/stores/auth.store';

/**
 * Whether the signed-in person is an Admin: the flag on the person, never a switch or a role name.
 *
 * Setting up the company is the Admin flag's alone (36b, M17), and so is managing people and roles and the phone service. A screen
 * that points a person at one of those pages (a "go to Settings" link, "add in Settings" text) shows the pointer to an Admin
 * and leaves it out for anyone else, who could not open the page it names.
 */
export function useIsAdmin(): boolean {
  return useAuthStore((s) => s.user?.is_admin === true);
}

/**
 * The word an empty option list gives: for an Admin, where to add some (the pointer names a Settings page only an Admin can open);
 * for anyone else, just "No options". `pointer` completes "No options - ...".
 */
export function useNoOptionsLabel(pointer = 'add in Settings'): string {
  return useIsAdmin() ? `No options - ${pointer}` : 'No options';
}
