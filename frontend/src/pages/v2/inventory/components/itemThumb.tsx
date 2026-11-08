import { Avatar } from '@/ui-kit/components/ui/avatar';
import type { Item } from '@/lib/api/inventory';

/**
 * The catalog item's photo.
 *
 * The legacy `ItemThumb` was a raw `<img>` with an `ImageIcon` placeholder
 * titled "No photo yet". The kit's Avatar already is that component - image
 * when there is one, a deterministic tinted initial fallback when there is not,
 * with `role="img"` and an accessible name either way - so it replaces both
 * halves. `rounded-md` squares it off: a product photo is not a face.
 */
export function ItemThumb({ item, size = 'default' }: { item: Item; size?: 'default' | 'lg' }) {
  return (
    <Avatar
      name={item.name}
      src={item.photoUrl}
      size={size}
      className="rounded-md"
      title={item.photoUrl ? item.name : 'No photo yet'}
    />
  );
}
