import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface BeeTablePaginationProps {
  totalItems: number;
  page: number;
  pageSize: number;
  onPageChange: (newPage: number) => void;
  onPageSizeChange: (newPageSize: number) => void;
  pageSizeOptions?: number[];
  isLoading?: boolean;
}

export const BeeTablePagination: React.FC<BeeTablePaginationProps> = ({
  totalItems,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [25, 50, 100],
  isLoading = false,
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, page), totalPages);

  const startRecord = totalItems === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1;
  const endRecord = Math.min(safeCurrentPage * pageSize, totalItems);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 bg-surface-light">
      <div className="text-text-secondary text-[12.5px]">
        Showing{' '}
        <span className="text-text-primary font-bold">
          {startRecord}-{endRecord}
        </span>{' '}
        of <span className="text-text-primary font-bold">{totalItems}</span>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary text-[12.5px] font-medium hidden sm:inline">
            Rows
          </span>
          <Select
            value={String(pageSize)}
            onValueChange={(val) => {
              onPageSizeChange(Number(val));
              onPageChange(1);
            }}
          >
            <SelectTrigger className="h-8 w-[4.5rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="z-[150]">
              {pageSizeOptions.map((opt) => (
                <SelectItem key={opt} value={String(opt)}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <span className="text-text-secondary text-[12.5px] font-medium">
          Page {totalItems === 0 ? 0 : safeCurrentPage} of {totalPages}
        </span>

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 hidden sm:inline-flex"
            onClick={() => onPageChange(1)}
            disabled={safeCurrentPage <= 1 || isLoading}
            title="First page"
          >
            <ChevronsLeft className="h-4 w-4" />
            <span className="sr-only">First page</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => onPageChange(safeCurrentPage - 1)}
            disabled={safeCurrentPage <= 1 || isLoading}
            title="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="sr-only">Previous page</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => onPageChange(safeCurrentPage + 1)}
            disabled={safeCurrentPage >= totalPages || isLoading}
            title="Next page"
          >
            <ChevronRight className="h-4 w-4" />
            <span className="sr-only">Next page</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 hidden sm:inline-flex"
            onClick={() => onPageChange(totalPages)}
            disabled={safeCurrentPage >= totalPages || isLoading}
            title="Last page"
          >
            <ChevronsRight className="h-4 w-4" />
            <span className="sr-only">Last page</span>
          </Button>
        </div>
      </div>
    </div>
  );
};

