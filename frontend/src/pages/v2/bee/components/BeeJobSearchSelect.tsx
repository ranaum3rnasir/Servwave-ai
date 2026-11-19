import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Search, ChevronDown, Check, Loader2, X, Sparkles } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { beeApi, BeeSampleJobContext } from '@/lib/api/bee';
import { cn, formatSnakeCase } from '@/lib/utils';
import { formatJobNumber } from '../tabs/BeeAgentsTab';

interface BeeJobSearchSelectProps {
  value?: string;
  onSelect: (job: BeeSampleJobContext | null) => void;
  onClear?: () => void;
  initialJobs?: BeeSampleJobContext[];
  placeholder?: string;
  triggerClassName?: string;
  disabled?: boolean;
}

export const BeeJobSearchSelect: React.FC<BeeJobSearchSelectProps> = ({
  value,
  onSelect,
  onClear,
  initialJobs = [],
  placeholder = 'Select a job to preview...',
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
  const [loadingAll, setLoadingAll] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Initialize recent 10 jobs immediately from initialJobs, and fetch accurate total count in background
  useEffect(() => {
    if (initialJobs.length > 0) {
      setJobs(initialJobs.slice(0, 10));
    }

    // Always fetch sample jobs metadata from backend so total and pagination are exact
    beeApi
      .getSampleJobs({ limit: 10, offset: 0 })
      .then((res) => {
        if (res.jobs && res.jobs.length > 0) {
          setJobs((prev) => {
            if (prev.length === 0) return res.jobs.slice(0, 10);
            return prev;
          });
          const serverTotal = res.total || res.jobs.length;
          setTotal(serverTotal);
          setHasMore(Boolean(res.hasMore) || serverTotal > 10);
        }
      })
      .catch(() => {});
  }, [initialJobs]);

  // Debounce search query changes (200ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
    }, 200);
    return () => clearTimeout(timer);
  }, [search]);

  // Fetch search results when debounced search query changes
  useEffect(() => {
    if (!open) return;

    const query = debouncedSearch.trim();

    // If search is empty, restore the recent 10 jobs without network latency or full-page spinner
    if (!query) {
      if (initialJobs.length > 0) {
        setJobs(initialJobs.slice(0, 10));
      }
      setLoading(false);
      return;
    }

    let isMounted = true;
    setLoading(true);

    beeApi
      .getSampleJobs({
        search: query,
        limit: 10,
        offset: 0,
      })
      .then((res) => {
        if (!isMounted) return;
        setJobs(res.jobs || []);
        const serverTotal = res.total || (res.jobs?.length || 0);
        setTotal(serverTotal);
        setHasMore(Boolean(res.hasMore) || serverTotal > (res.jobs?.length || 0));
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
  }, [open, debouncedSearch, initialJobs]);

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
      if (loadingMore || loadingAll || !hasMore) return;

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
            const updated = [...prev, ...newJobs];
            const updatedTotal = res.total || total || updated.length;
            setHasMore(Boolean(res.hasMore) || updatedTotal > updated.length);
            return updated;
          });
          if (res.total) setTotal(res.total);

          setTimeout(() => {
            if (scrollContainerRef.current) {
              scrollContainerRef.current.scrollTo({
                top: currentScrollHeight - 30,
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
    [loadingMore, loadingAll, hasMore, debouncedSearch, jobs.length, total]
  );

  // "Show all": load all remaining records
  const handleLoadAll = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (loadingMore || loadingAll || !hasMore) return;

      setLoadingAll(true);
      try {
        const remainingToFetch = total > jobs.length ? total - jobs.length : 100;
        const res = await beeApi.getSampleJobs({
          search: debouncedSearch.trim() || undefined,
          limit: Math.max(remainingToFetch, 100),
          offset: jobs.length,
        });

        if (res.jobs && res.jobs.length > 0) {
          setJobs((prev) => {
            const existingIds = new Set(prev.map((j) => j.id));
            const newJobs = res.jobs.filter((j) => !existingIds.has(j.id));
            return [...prev, ...newJobs];
          });
          setHasMore(false);
          if (res.total) setTotal(res.total);
        } else {
          setHasMore(false);
        }
      } catch (err) {
        console.error('Failed to load all jobs:', err);
      } finally {
        setLoadingAll(false);
      }
    },
    [loadingMore, loadingAll, hasMore, debouncedSearch, jobs.length, total]
  );

  // Client-side instant filter over loaded jobs while waiting for debounce/backend
  const displayJobs = useMemo(() => {
    if (!search.trim()) return jobs;
    const q = search.trim().toLowerCase();
    const cleanNum = q.replace(/^#+/, '');

    // If debounced API search already returned results, use them
    if (debouncedSearch.trim() === search.trim() && !loading) {
      return jobs;
    }

    // Instant filter across jobs in memory (by job number, customer name, or job type)
    return jobs.filter((job) => {
      const matchNum = job.job_number && job.job_number.toLowerCase().includes(cleanNum);
      const matchCust = job.customer_name && job.customer_name.toLowerCase().includes(q);
      const matchType = job.job_type && job.job_type.toLowerCase().includes(q);
      return Boolean(matchNum || matchCust || matchType);
    });
  }, [jobs, search, debouncedSearch, loading]);

  // Selected job label display
  const selectedJob =
    jobs.find((j) => j.id === value) ||
    initialJobs.find((j) => j.id === value);

  const selectedDisplayLabel = selectedJob
    ? `Job ${formatJobNumber(selectedJob.job_number)} - ${selectedJob.customer_name} (${formatSnakeCase(selectedJob.job_type)})`
    : placeholder;

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(null);
    onClear?.();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex items-center justify-between gap-1.5 px-2.5 py-1 text-xs rounded-lg border border-slate-200 bg-white hover:bg-slate-50/80 transition-colors cursor-pointer text-left focus:outline-none focus:ring-1 focus:ring-primary shadow-2xs group',
            triggerClassName || 'h-8 w-[250px]'
          )}
          title={selectedDisplayLabel}
        >
          <span
            className={cn(
              'truncate font-normal',
              selectedJob ? 'text-slate-800 font-medium' : 'text-slate-400'
            )}
          >
            {selectedDisplayLabel}
          </span>
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            {selectedJob && (
              <span
                role="button"
                tabIndex={0}
                onClick={handleClear}
                className="p-0.5 rounded-full hover:bg-slate-200/70 text-slate-400 hover:text-slate-700 cursor-pointer"
                title="Clear referenced job (show raw variables)"
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <ChevronDown className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          </div>
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="w-[340px] p-0 z-[170] shadow-lg border border-slate-200/90 rounded-xl overflow-hidden bg-white animate-in fade-in-50 zoom-in-95"
      >
        {/* Search Bar at the top */}
        <div className="p-2 border-b border-slate-100 bg-slate-50/60">
          <div className="relative">
            {loading ? (
              <Loader2 className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-primary pointer-events-none" />
            ) : (
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
            )}
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

        {/* Scrollable Results List */}
        <div
          ref={scrollContainerRef}
          className="max-h-[260px] overflow-y-auto divide-y divide-slate-50 overscroll-contain"
        >
          {/* Default Option: Raw Variables (No job referenced) */}
          {!search.trim() && (
            <button
              type="button"
              onClick={() => {
                onSelect(null);
                onClear?.();
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 text-xs flex items-center justify-between gap-2 hover:bg-slate-50/90 transition-colors cursor-pointer group border-b border-slate-100/80',
                !value && 'bg-slate-100/70 font-semibold text-slate-900'
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-3.5 shrink-0 flex items-center justify-center">
                  {!value ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                </div>
                <div className="flex items-center gap-1.5 text-slate-600">
                  <Sparkles className="h-3 w-3 text-slate-400" />
                  <span className="italic">None (Show raw variables)</span>
                </div>
              </div>
            </button>
          )}

          {loading && displayJobs.length === 0 ? (
            <div className="py-8 flex flex-col items-center justify-center gap-2 text-slate-400 text-xs">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>Searching jobs...</span>
            </div>
          ) : displayJobs.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-400 px-4">
              {search.trim() ? (
                <>
                  No jobs found matching &ldquo;
                  <span className="text-slate-600 font-medium">{search.trim()}</span>
                  &rdquo;
                </>
              ) : (
                'No jobs available in this organization.'
              )}
            </div>
          ) : (
            displayJobs.map((job) => {
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

        {/* Bottom Bar: Showing status + "See more" (+10) and "Show all" buttons */}
        {!loading && displayJobs.length > 0 && (
          <div className="p-1.5 px-2.5 border-t border-slate-100 bg-slate-50/80 flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500 font-medium truncate">
              {hasMore ? (
                <>
                  Showing <span className="text-slate-800 font-semibold">{displayJobs.length}</span>
                  {total > 0 ? (
                    <>
                      {' '}of <span className="text-slate-800 font-semibold">{total}</span>
                    </>
                  ) : ''}
                </>
              ) : (
                <>
                  Showing all <span className="text-slate-800 font-semibold">{displayJobs.length}</span>{' '}
                  {displayJobs.length === 1 ? 'job' : 'jobs'}
                </>
              )}
            </span>

            {hasMore && (
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleLoadMore}
                  disabled={loadingMore || loadingAll}
                  className="h-6 px-2 text-[11px] font-medium text-slate-700 bg-white hover:bg-slate-100 hover:text-slate-900 border-slate-200 cursor-pointer gap-1 shadow-2xs"
                  title="Load next 10 jobs"
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

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleLoadAll}
                  disabled={loadingMore || loadingAll}
                  className="h-6 px-2 text-[11px] font-semibold text-primary hover:text-primary hover:bg-primary/10 cursor-pointer"
                  title="Load all remaining jobs"
                >
                  {loadingAll ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin text-primary" />
                      <span>All...</span>
                    </>
                  ) : (
                    <span>Show all</span>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

