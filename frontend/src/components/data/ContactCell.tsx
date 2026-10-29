import { useState } from 'react';
import { Copy } from 'lucide-react';
import { cn, formatPhone } from '@/lib/utils';
import { isPlaceholderEmail, isPlaceholderPhone } from '@/lib/placeholders';

interface ContactCellProps {
  value: string | null | undefined;
  type: 'phone' | 'email';
}

export function ContactCell({ value, type }: ContactCellProps) {
  const [copied, setCopied] = useState(false);

  if (!value) return null;
  if (type === 'phone' && isPlaceholderPhone(value)) return null;
  if (type === 'email' && isPlaceholderEmail(value)) return null;

  const href = type === 'phone' ? `tel:${value}` : `mailto:${value}`;
  const ariaLabel = type === 'phone' ? 'Copy phone number' : 'Copy email address';

  function handleLinkClick(e: React.MouseEvent) {
    e.stopPropagation();
  }

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(value as string).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <span className="inline-flex items-center gap-1 group">
      <a
        href={href}
        onClick={handleLinkClick}
        className="text-sm hover:underline truncate"
      >
        {type === 'phone' ? formatPhone(value) : value}
      </a>
      {/* Raw by design: the reveal here is a group-hover:opacity visibility toggle,
          not the Button primitive's revealOnHover colour modifier (which only
          exists for ghost/danger) - the two mechanisms aren't interchangeable,
          and ghost/danger#reveal would also tint this neutral copy icon red. */}
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={handleCopy}
        className={cn(
          'opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-background-light',
          copied && 'opacity-100'
        )}
      >
        {copied ? (
          <span className="text-xs text-success-text">Copied!</span>
        ) : (
          <Copy className="h-3 w-3 text-text-secondary" />
        )}
      </button>
    </span>
  );
}
