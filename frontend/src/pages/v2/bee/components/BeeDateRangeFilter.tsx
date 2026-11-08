import React from 'react';
import { Calendar } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DatePicker } from '@/components/form/DatePicker';

export interface DateRangeState {
  preset: string; // 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'thisMonth' | 'custom'
  from?: string; // 'YYYY-MM-DD'
  to?: string; // 'YYYY-MM-DD'
}

export interface BeeDateRangeFilterProps {
  value: DateRangeState;
  onChange: (next: DateRangeState) => void;
  className?: string;
}

export function matchesDateRange(
  rawDate: string | number | Date | null | undefined,
  filter: DateRangeState
): boolean {
  if (!filter || filter.preset === 'all') return true;
  if (!rawDate) return false;

  const d = new Date(rawDate);
  if (isNaN(d.getTime())) return true;

  const now = new Date();

  if (filter.preset === 'today') {
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return d >= startOfToday && d <= endOfToday;
  }

  if (filter.preset === 'yesterday') {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    const start = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 0, 0, 0);
    const end = new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate(), 23, 59, 59, 999);
    return d >= start && d <= end;
  }

  if (filter.preset === '7d') {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return d >= sevenDaysAgo;
  }

  if (filter.preset === '30d') {
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return d >= thirtyDaysAgo;
  }

  if (filter.preset === 'thisMonth') {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return d >= startOfMonth && d <= endOfMonth;
  }

  if (filter.preset === 'custom') {
    if (filter.from) {
      const fromDate = new Date(`${filter.from}T00:00:00`);
      if (!isNaN(fromDate.getTime()) && d < fromDate) return false;
    }
    if (filter.to) {
      const toDate = new Date(`${filter.to}T23:59:59.999`);
      if (!isNaN(toDate.getTime()) && d > toDate) return false;
    }
    return true;
  }

  return true;
}

export const BeeDateRangeFilter: React.FC<BeeDateRangeFilterProps> = ({
  value,
  onChange,
  className = '',
}) => {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <div className="flex items-center gap-1.5">
        <Select
          value={value.preset}
          onValueChange={(preset) => {
            onChange({
              preset,
              from: preset === 'custom' ? value.from || '' : undefined,
              to: preset === 'custom' ? value.to || '' : undefined,
            });
          }}
        >
          <SelectTrigger className="h-9 w-[145px] text-xs gap-1.5">
            <Calendar className="h-3.5 w-3.5 text-text-secondary flex-shrink-0" />
            <SelectValue placeholder="Date range" />
          </SelectTrigger>
          <SelectContent className="z-[150]">
            <SelectItem value="all">All dates</SelectItem>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="yesterday">Yesterday</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="thisMonth">This month</SelectItem>
            <SelectItem value="custom">Custom range...</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {value.preset === 'custom' && (
        <div className="flex items-center gap-1.5 animate-in fade-in duration-200">
          <DatePicker
            value={value.from || ''}
            max={value.to || undefined}
            onChange={(from) => onChange({ ...value, from })}
            placeholder="From"
            className="w-[8.5rem]"
            inputClassName="h-9 text-xs"
          />
          <span className="text-text-secondary text-xs">-</span>
          <DatePicker
            value={value.to || ''}
            min={value.from || undefined}
            onChange={(to) => onChange({ ...value, to })}
            placeholder="To"
            className="w-[8.5rem]"
            inputClassName="h-9 text-xs"
          />
        </div>
      )}
    </div>
  );
};

