/**
 * One step of a reorder without a drag (mobile slice 48).
 *
 * Move up / Move down on the settings lists and the dashboard widgets report the same complete
 * new order a drag would, so the saved order cannot differ between the two ways of getting there.
 * `null` means there is nowhere to go (first item up, last item down, or an unknown index): the
 * control is disabled in that case and a stray call changes nothing.
 */
export type MoveDirection = 'up' | 'down';

export function moveInList<T>(list: readonly T[], index: number, direction: MoveDirection): T[] | null {
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= list.length) return null;
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as T);
  return next;
}
