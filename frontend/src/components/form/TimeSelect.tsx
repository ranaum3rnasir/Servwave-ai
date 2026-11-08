import { useMemo } from 'react';
import { format } from 'date-fns';

import { SelectField } from '@/components/form/SelectField';
import { cn } from '@/lib/utils';

interface TimeSelectProps {
  /** 'HH:MM' (24-hour) or '' — same string contract as <input type="time">. */
  value: string;
  onChange: (v: string) => void;
  stepMinutes?: number;
  className?: string;
  id?: string;
}

/**
 * Time-only scrollable dropdown replacing the native <input type="time">
 * '--:--' spinner on the Lead schedule fields (#358). Options are generated
 * every `stepMinutes` (default 15) across the full day with readable 12-hour
 * `h:mm a` labels; the value contract stays 'HH:MM' so callers are unchanged.
 * A saved off-grid time (e.g. '09:07') is prepended so it stays selected.
 */
export function TimeSelect({
  value,
  onChange,
  stepMinutes = 15,
  className,
  id,
}: TimeSelectProps) {
  const timeOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [];
    for (let m = 0; m < 24 * 60; m += stepMinutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      opts.push({
        value: `${hh}:${mm}`,
        label: format(new Date(2000, 0, 1, Math.floor(m / 60), m % 60), 'h:mm a'),
      });
    }
    return opts;
  }, [stepMinutes]);

  const options =
    value && !timeOptions.some((o) => o.value === value)
      ? [
          { value, label: format(new Date(`2000-01-01T${value}`), 'h:mm a') },
          ...timeOptions,
        ]
      : timeOptions;

  return (
    <SelectField
      value={value || 'NONE'}
      onValueChange={(v) => onChange(v === 'NONE' ? '' : v)}
      className={cn(
        'h-10 w-[140px] text-sm focus:ring-2 focus:ring-primary/40',
        className,
      )}
      options={[{ value: 'NONE', label: 'Select time…' }, ...options]}
    />
  );
}
