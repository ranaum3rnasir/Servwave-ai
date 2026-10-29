import { useState } from 'react';
import { Link } from 'react-router-dom';
import { History } from 'lucide-react';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';
import { Card, CardContent } from '@/ui-kit/components/ui/card';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui-kit/components/ui/table';
import { useSpiderHistory, type SpiderHistoryItem } from '@/lib/api/spider';

const PAGE_SIZE = 25;

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Every alert Spider raised for this company, newest first (#2619). Delivery outcomes are shown
 * exactly as the server wrote them - plain words - and people by name only.
 */
export function SpiderHistory() {
  const [page, setPage] = useState(1);
  const history = useSpiderHistory(page, PAGE_SIZE);

  if (history.isLoading) {
    return (
      <div className="flex items-center gap-2 py-10" role="status">
        <Spinner />
        <span className="text-sm text-text-secondary">Loading Spider history…</span>
      </div>
    );
  }
  if (history.isError || !history.data) {
    return (
      <Card>
        <CardContent className="flex flex-col items-start gap-3 py-6">
          <p role="alert" className="text-sm text-danger-text">
            {extractApiError(history.error, 'Could not load Spider history.')}
          </p>
          <Button variant="outline" onClick={() => history.refetch()}>
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { items, total, total_pages } = history.data;
  if (total === 0) {
    return (
      <EmptyState
        icon={<History aria-hidden />}
        title="No Spider alerts yet"
        description="Every alert Spider sends shows up here, with who it reached and how."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Lead</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Alerted</TableHead>
            <TableHead>Delivery</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <HistoryRow key={item.id} item={item} />
          ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-text-secondary">
          Page {page} of {total_pages} · {total} alert{total === 1 ? '' : 's'}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button variant="outline" size="sm" disabled={page >= total_pages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryRow({ item }: { item: SpiderHistoryItem }) {
  const outcomes = [item.channels.in_app, item.channels.email, item.channels.text].filter(Boolean) as string[];
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">{when(item.alerted_at)}</TableCell>
      <TableCell>
        <div className="flex flex-col">
          <Link to={`/leads/${item.lead_id}`} className="font-mono text-xs font-semibold text-primary hover:underline">
            {item.lead_number}
          </Link>
          <span className="text-sm">{item.customer_name}</span>
        </div>
      </TableCell>
      <TableCell>{item.status_label}</TableCell>
      <TableCell>
        <ul className="flex flex-col gap-0.5 text-sm">
          {item.recipients.map((r, i) => (
            <li key={i}>
              {r.name}
              {(r.email_outcome || r.text_outcome) && (
                <span className="block text-xs text-text-secondary">
                  {[r.email_outcome, r.text_outcome].filter(Boolean).join(' · ')}
                </span>
              )}
            </li>
          ))}
        </ul>
      </TableCell>
      <TableCell>
        <ul className="flex flex-col gap-0.5 text-sm">
          {outcomes.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      </TableCell>
    </TableRow>
  );
}
