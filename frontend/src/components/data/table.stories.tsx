/* =============================================================================
   Table - Storybook stories, phase 12a pass.

   WHY THIS FILE EXISTS. Before DesignSystemPage was retired, its "Table"
   section was the only place this primitive cluster rendered outside a real
   page. `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`
   are real, shipped primitives with 4+ real page consumers
   (LocationsPage, CompanyProfilePage, UsersTeamsPage, ServicePlansPage) and
   `DataTable` itself is built on this exact cluster - retiring the page
   without a replacement would have deleted their only designer-facing
   documentation.

   NOT THE SAME THING AS DataTable. `DataTable` (its own primitive, its own
   Storybook story under UI/DataTable) is the list-page component - sorting,
   pinned columns, pagination. This cluster is the raw building block
   DataTable itself composes from, for a caller that wants a plain table
   with none of that machinery - a settings page, a summary panel.

   TableCell IS RATCHETED (component-api-guard's per-primitive `CEILINGS`,
   currently 3/3, at floor) - the file's own header states it plainly: "Every
   adoption goes through a prop. Never widen a call site with className."
   Every TableCell in this file is styled through its own props (`tone`,
   `align`, `scale`, `weight`, `divider`) and NEVER through a raw className
   override, for exactly that reason - this is not a style preference, it is
   what keeps the ratchet real.

   THE THREE NAMED TableHead VARIANTS ARE BUNDLES, NOT INDEPENDENT AXES. The
   source's own header explains why: giving TableHead one axis per
   measured difference (height, size, weight, casing, tracking) would hand
   it an axis for every class in its own default string, which is not
   extending a primitive, it is dissolving one. `Default`/`PlainHeader`/
   `CompactHeader` below render the three MEASURED signatures this tree
   actually uses, named exactly as the source names them.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { formatCurrency } from '@/lib/utils';

import {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from './table';

const invoiceRows = [
  { id: 'I00041', customer: 'Northside HVAC', status: 'Paid', amount: 4250 },
  { id: 'I00042', customer: 'Cedar Plumbing Co.', status: 'Sent', amount: 1820 },
  { id: 'I00043', customer: 'Mainline Electric', status: 'Overdue', amount: 3675 },
  { id: 'I00044', customer: 'Harbor Mechanical', status: 'Draft', amount: 990 },
];

const meta = {
  title: 'Data/Table',
  component: Table,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The raw table primitive cluster DataTable itself composes from. Use it directly for a plain table with no sorting, pinning or pagination.',
      },
    },
  },
  argTypes: {
    wrapper: {
      control: { type: 'inline-radio' },
      options: ['auto', 'x', 'none'],
      description:
        "Which scroll container the table sits in. \"auto\" (default) is today's both-axis wrapper; \"x\" scrolls horizontally only; \"none\" renders the bare table with no wrapper, for a parent that already owns the scroll.",
    },
    className: { control: false },
  },
} satisfies Meta<typeof Table>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The default header (`variant="default"`): 40px tall, tracked uppercase, no fill. The ServWave shipped signature. */
export const Default: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead>Status</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.map((row) => (
          <TableRow key={row.id}>
            <TableCell weight="semibold">{row.id}</TableCell>
            <TableCell>{row.customer}</TableCell>
            <TableCell>{row.status}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/** `variant="plain"` - a header that reads as a heavier body row: inherits the table's own size, no letter-casing change, no tracking. */
export const PlainHeader: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead variant="plain">Invoice</TableHead>
          <TableHead variant="plain">Customer</TableHead>
          <TableHead variant="plain" align="right">
            Amount
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.id}</TableCell>
            <TableCell>{row.customer}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/** `variant="compact"` - small tracked uppercase, no height floor, sitting directly above its rows. */
export const CompactHeader: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead variant="compact">Invoice</TableHead>
          <TableHead variant="compact">Customer</TableHead>
          <TableHead variant="compact" align="right">
            Amount
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell scale="xs">{row.id}</TableCell>
            <TableCell scale="xs">{row.customer}</TableCell>
            <TableCell scale="xs" align="right">
              {formatCurrency(row.amount)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/** `TableCell tone="highlight"` draws the eye to a value that needs attention - here, an overdue amount. */
export const HighlightedCell: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>{invoiceRows[2]!.id}</TableCell>
          <TableCell align="right" tone="highlight">
            {formatCurrency(invoiceRows[2]!.amount)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** `TableRow tone="danger"`, tinted not outlined - a row that reverses the table's usual direction, e.g. a refund inside a ledger of collections. */
export const DangerRow: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Description</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Service call</TableCell>
          <TableCell align="right">{formatCurrency(180)}</TableCell>
        </TableRow>
        <TableRow tone="danger">
          <TableCell>Refund</TableCell>
          <TableCell align="right">{formatCurrency(-45)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** `TableRow muted` dims a row that is still listed but no longer counts - a voided line, a cancelled visit. */
export const MutedRow: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Description</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow muted>
          <TableCell>Voided line item</TableCell>
          <TableCell align="right">{formatCurrency(0)}</TableCell>
        </TableRow>
        <TableRow>
          <TableCell>Active line item</TableCell>
          <TableCell align="right">{formatCurrency(120)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** `TableRow interactive` lights the row up under the pointer - set it only where the row is actually clickable. */
export const InteractiveRow: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead>Customer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id} interactive>
            <TableCell>{row.id}</TableCell>
            <TableCell>{row.customer}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};

/** `TableBody divider="hairline"` draws the rules on the section instead of each row - the ledger's own treatment. */
export const HairlineBodyDivider: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead variant="compact">Date</TableHead>
          <TableHead variant="compact" align="right">
            Amount
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody divider="hairline">
        <TableRow divider="none">
          <TableCell scale="xs">Jul 14</TableCell>
          <TableCell scale="xs" align="right">
            {formatCurrency(320)}
          </TableCell>
        </TableRow>
        <TableRow divider="none">
          <TableCell scale="xs">Jul 15</TableCell>
          <TableCell scale="xs" align="right">
            {formatCurrency(180)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** `TableCell divider` draws a hairline right border between columns - DataTable's own column-divider pattern, available on this raw cluster too. */
export const CellColumnDividers: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Labor</TableHead>
          <TableHead>Parts</TableHead>
          <TableHead>Travel</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell divider>{formatCurrency(180)}</TableCell>
          <TableCell divider>{formatCurrency(90)}</TableCell>
          <TableCell>{formatCurrency(22)}</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  ),
};

/** `TableFooter` (`variant="default"`) - filled, top-ruled, medium-weight, for a totals row. */
export const WithFooter: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.id}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell weight="semibold">Total</TableCell>
          <TableCell align="right" weight="semibold">
            {formatCurrency(invoiceRows[0]!.amount + invoiceRows[1]!.amount)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

/** `TableFooter variant="bare"` - a summary line rather than a filled band, the ledger's own treatment. */
export const BareFooter: Story = {
  args: {},
  render: () => (
    <Table>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.id}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter variant="bare">
        <TableRow>
          <TableCell scale="xs" tone="muted">
            2 invoices
          </TableCell>
          <TableCell scale="xs" tone="muted" align="right">
            {formatCurrency(invoiceRows[0]!.amount + invoiceRows[1]!.amount)}
          </TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  ),
};

/** `TableCaption` - a caption below the table, muted secondary copy. */
export const WithCaption: Story = {
  args: {},
  render: () => (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.id}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableCaption>Showing 2 of 4 invoices.</TableCaption>
    </Table>
  ),
};

/** `wrapper="none"` - the bare table with no scroll container, for a parent that already owns the scroll or the width. */
export const NoWrapper: Story = {
  args: {},
  render: () => (
    <Table wrapper="none">
      <TableHeader>
        <TableRow>
          <TableHead>Invoice</TableHead>
          <TableHead align="right">Amount</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoiceRows.slice(0, 2).map((row) => (
          <TableRow key={row.id}>
            <TableCell>{row.id}</TableCell>
            <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  ),
};
