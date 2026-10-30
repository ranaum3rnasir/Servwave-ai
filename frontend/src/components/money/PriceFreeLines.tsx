import { Card, CardContent, CardHeader, CardTitle } from '@/ui-kit/components/ui/card';

/**
 * What an estimate, invoice or job shows of its lines to a person without See prices (P11): what the work is and how many,
 * with no price, total, discount or tax anywhere. The priced grids are for people who hold the switch; this stands in
 * for them instead of drawing the same grid with its figures blanked, so there is no empty column or "$0.00" to read.
 */
export interface PriceFreeLine {
  id: string;
  description: string;
  quantity: string | number;
}

export interface PriceFreeScope {
  id: string;
  title: string;
  body?: string | null;
}

export function PriceFreeLines({
  lines,
  scopes = [],
  title = 'Items',
}: {
  lines: readonly PriceFreeLine[];
  scopes?: readonly PriceFreeScope[];
  title?: string;
}) {
  if (lines.length === 0 && scopes.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {scopes.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Scope of work">
            {scopes.map((scope) => (
              <li key={scope.id}>
                <p className="text-sm font-medium">{scope.title}</p>
                {scope.body ? <p className="text-muted-foreground text-sm whitespace-pre-wrap">{scope.body}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {lines.length > 0 && (
          <ul className="divide-y" aria-label="Line items">
            {lines.map((line) => (
              <li key={line.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span className="min-w-0 break-words">{line.description}</span>
                <span className="text-muted-foreground shrink-0 tabular-nums">× {Number(line.quantity)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
