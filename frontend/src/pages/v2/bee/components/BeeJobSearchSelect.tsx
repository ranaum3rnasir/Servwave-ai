import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, ChevronDown, Check, Loader2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { beeApi, BeeSampleJobContext } from '@/lib/api/bee';
import { cn, formatSnakeCase } from '@/lib/utils';
import { formatJobNumber } from '../tabs/BeeAgentsTab';

interface BeeJobSearchSelectProps {
  value?: string;
  onSelect: (job: BeeSampleJobContext) => void;
  initialJobs?: BeeSampleJobContext[];
  placeholder?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

export const BeeJobSearchSelect: React.FC<BeeJobSearchSelectProps> = ({
  value,
  onSelect,
  initialJobs = [],
  placeholder = 'Select existing job',
  triggerClassName,
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [jobs, setJobs] = useState<BeeSampleJobContext[]>(() =>
    initialJobs.length > 0 ? initialJobs.slice(0, 10) : []
  );
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search query changes (250ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  // Sync initialJobs if jobs is empty
  useEffect(() => {
    if (jobs.length === 0 && initialJobs.length > 0) {
      setJobs(initialJobs.slice(0, 10));
      setHasMore(initialJobs.length > 10);
    }
  }, [initialJobs, jobs.length]);

  // Fetch first page (10 records) when popover opens or debounced search changes
  useEffect(() => {
    if (!open) return;

    let isMounted = true;
    setLoading(true);

    beeApi
      .getSampleJobs({
        search: debouncedSearch.trim() || undefined,
        limit: 10,
        offset: 0,
        jobId: value || undefined,
      })
      .then((res) => {
        if (!isMounted) return;
        setJobs(res.jobs || []);
        setHasMore(Boolean(res.hasMore));
        setTotal(res.total || 0);
      })
      .catch((err) => {
        console.error('Failed to search sample jobs:', err);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [open, debouncedSearch, value]);

  // Focus input when popover opens
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    } else {
      setSearch('');
    }
  }, [open]);

  // "See more": load next 10 records and scroll down smoothly
  const handleLoadMore = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (loadingMore || !hasMore) return;

      setLoadingMore(true);
      const currentScrollHeight = scrollContainerRef.current?.scrollHeight || 0;

      try {
        const res = await beeApi.getSampleJobs({
          search: debouncedSearch.trim() || undefined,
          limit: 10,
          offset: jobs.length,
        });

        if (res.jobs && res.jobs.length > 0) {
          setJobs((prev) => {
            const existingIds = new Set(prev.map((j) => j.id));
            const newJobs = res.jobs.filter((j) => !existingIds.has(j.id));
            return [...prev, ...newJobs];
          });
          setHasMore(Boolean(res.hasMore));
          setTotal(res.total || 0);

          // Scroll down to newly loaded records
          setTimeout(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTo({
                top: currentScrollHeight - 40,
                behavior: 'smooth',
              });
            }
          }, 80);
        } else {
          setHasMore(false);
        }
      } catch (err) {
        console.error('Failed to load more jobs:', err);
      } finally {
        setLoadingMore(false);
      }
    },
    [loadingMore, hasMore, debouncedSearch, jobs.length]
  );

  // Selected job label display
  const selectedJob =
    jobs.find((j) => j.id === value) ||
    initialJobs.find((j) => j.id === value);

  const selectedDisplayLabel = selectedJob
    ? `Job ${formatJobNumber(selectedJob.job_number)} - ${selectedJob.customer_name} (${formatSnakeCase(selectedJob.job_type)})`
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center justify-between gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-white hover:bg-slate-50/80 transition-colors cursor-pointer text-left focus:outline-none focus:ring-1 focus:ring-primary shadow-2xs',
            triggerClassName || 'h-8 w-[240px]'
          )}
          title={selectedDisplayLabel}
        >
          <span className="truncate text-slate-800 font-normal">
            {selectedDisplayLabel}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0 ml-auto" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[340px] p-0 z-[170] shadow-lg border border-slate-200/90 rounded-xl overflow-hidden bg-white animate-in fade-in-50 zoom-in-95"
      >
        {/* Search Bar at the top */}
        <div className="p-2 border-b border-slate-100 bg-slate-50/60">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            <Input
              ref={inputRef}
              type="text"
              placeholder="Search by Job #, customer, or job type..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 pr-7 text-xs bg-white border-slate-200 focus-visible:ring-1 focus-visible:ring-primary shadow-none"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                title="Clear search"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Scrollable Results List (max 10 initially, grows on See more while keeping same container size) */}
        <div
          ref={scrollContainerRef}
          className="max-h-[250px] overflow-y-auto divide-y divide-slate-50 overscroll-contain"
        >
          {loading ? (
            <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-400 text-xs">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>Searching jobs...</span>
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 px-4">
              {search.trim() ? (
                <>
                  No jobs found matching &ldquo;<span className="text-slate-600 font-medium">{search.trim()}</span>&rdquo;
                </>
              ) : (
                'No jobs available in this organization.'
              )}
            </div>
          ) : (
            jobs.map((job) => {
              const isSelected = job.id === value;
              const formattedNum = formatJobNumber(job.job_number);

              return (
                <button
                  type="button"
                  key={job.id}
                  onClick={() => {
                    onSelect(job);
                    setOpen(false);
                  }}
                  className={cn(
                    'w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 hover:bg-slate-50/90 transition-colors cursor-pointer group',
                    isSelected && 'bg-primary/5 text-primary font-medium'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-3.5 shrink-0 flex items-center justify-center">
                      {isSelected ? (
                        <Check className="h-3.5 w-3.5 text-primary" />
                      ) : null}
                    </div>
                    <span className="truncate text-slate-800 group-hover:text-slate-900">
                      Job {formattedNum} - {job.customer_name} ({formatSnakeCase(job.job_type)})
                    </span>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Bottom "See more" Button to pull next 10 records without changing container size */}
        {hasMore && !loading && (
          <div className="p-1.5 border-t border-slate-100 bg-slate-50/70 flex items-center justify-between gap-2">
            <span className="text-[10px] text-slate-400 pl-2">
              Showing {jobs.length}{total > 0 ? ` of ${total}` : ''}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="h-6 px-2.5 text-[11px] font-medium text-slate-700 bg-white hover:bg-slate-100 hover:text-slate-900 border-slate-200 cursor-pointer gap-1 shadow-2xs"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                  <span>Loading...</span>
                </>
              ) : (
                <>
                  <span>See more</span>
                  <ChevronDown className="h-3 w-3 text-slate-400" />
                </>
              )}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

