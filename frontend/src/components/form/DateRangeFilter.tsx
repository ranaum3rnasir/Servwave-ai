import { DatePicker } from '@/components/form/DatePicker';

export interface DateRangeFilterProps {
  /** Column label, e.g. "Created" / "Scheduled" / "Due". */
  label: string;
  from: string;   // 'YYYY-MM-DD' | ''
  to: string;     // 'YYYY-MM-DD' | ''
  onChange: (next: { from: string; to: string }) => void;
}

export function DateRangeFilter({ label, from, to, onChange }: DateRangeFilterProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium text-text-secondary whitespace-nowrap">{label}</span>
      <DatePicker value={from} max={to || undefined}
        onChange={(v) => onChange({ from: v, to })}
        className="w-[9.5rem]" inputClassName="h-9" aria-label={`${label} from`} />
      <span className="text-text-secondary">–</span>
      <DatePicker value={to} min={from || undefined}
        onChange={(v) => onChange({ from, to: v })}
        className="w-[9.5rem]" inputClassName="h-9" aria-label={`${label} to`} />
    </div>
  );
}
