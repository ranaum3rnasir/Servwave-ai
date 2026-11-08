import { ServWaveMark } from '@/components/brand/ServWaveMark';
import { cn } from '@/ui-kit/lib/utils';

interface BrandLockupProps {
  /**
   * `onFill` paints the mark and the wordmark for a saturated brand panel;
   * `brand` is the ocean-on-light treatment used on the form side and on the
   * invite card. Same two treatments the legacy pages hand-roll.
   */
  tone?: 'brand' | 'onFill';
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * The ServWave mark + wordmark lockup.
 *
 * Extracted because Login renders it twice (the brand panel and the
 * below-lg mobile header) and AcceptInvite a third time, and all three were
 * copy-pasted markup in the legacy pages. The kit ships no brand primitive -
 * `TopBarBrand` is shell chrome and drags the topbar's own geometry with it -
 * so the mark itself is still the app's `ServWaveMark`.
 */
export function BrandLockup({ tone = 'brand', size = 'md', className }: BrandLockupProps) {
  const ink = tone === 'onFill' ? 'text-on-fill' : 'text-primary';
  return (
    <div
      className={cn('flex items-center justify-center', size === 'lg' ? 'gap-3' : 'gap-2', className)}
    >
      <ServWaveMark className={cn(ink, size === 'lg' ? 'h-10 w-auto' : 'h-9 w-auto')} />
      <span className={cn('text-3xl font-bold tracking-tight', ink)}>ServWave</span>
    </div>
  );
}
