import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';

export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <Badge
      variant="outline"
      className="cursor-pointer gap-1 pl-2 pr-1 hover:bg-background-light"
      onClick={onRemove}
    >
      {label}
      <X className="h-3 w-3" />
    </Badge>
  );
}
