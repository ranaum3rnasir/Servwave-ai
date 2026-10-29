import { cn } from '@/lib/utils';
import { COUNTER_FROM } from '@/lib/textLimits';

/**
 * `18,500 / 20,000` under a long-text field, from 90% of the limit upward and nothing below it.
 * Pair it with the field's validation message rather than an HTML `maxLength`, which silently
 * cuts a paste.
 */
export function TextLengthCounter({ length, max }: { length: number; max: number }) {
  if (length < max * COUNTER_FROM) return null;
  return (
    <p className={cn('text-xs', length > max ? 'text-danger' : 'text-text-secondary')}>
      {length.toLocaleString('en-US')} / {max.toLocaleString('en-US')}
    </p>
  );
}
