import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCSVDialog } from '@/components/inventory/ImportCSVDialog';
import type { ImportItemsResult } from '@/lib/api/inventory';

// A count tells the operator nothing they can act on. When an import comes back
// with problems, the dialog has to stay open and name, for each one, the line in
// THEIR spreadsheet and what to change. These pin that, and specifically pin the
// line arithmetic, which is the part that silently goes wrong.

vi.mock('@/lib/inventory/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory/csv')>()),
  downloadCSV: vi.fn(),
}));

function dropCSV(text: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], 'catalog.csv', { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

function result(over: Partial<ImportItemsResult> = {}): ImportItemsResult {
  return { created: 0, updated: 0, errors: [], warnings: [], createdCategories: [], ...over };
}

const THREE_ROWS = [
  'SKU,Name,Category,Sell Price',
  'A-1,Hinge,Locksets,6.50',
  'A-2,Panel,Locksets,9.00',
  'A-3,Screw,Locksets,1.00',
].join('\n');

beforeEach(() => vi.clearAllMocks());

async function importAndGetPanel(csv: string, res: ImportItemsResult) {
  const onImport = vi.fn().mockResolvedValue(res);
  render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
  dropCSV(csv);
  const submit = await screen.findByRole('button', { name: /^Import \d+ item/i });
  await userEvent.click(submit);
  await waitFor(() => expect(onImport).toHaveBeenCalled());
  return onImport;
}

describe('ImportCSVDialog — no silent coercion', () => {
  // Found in staging QA of #2022: a row with a blank Name imported as
  // "Unnamed Item" and a bad price as 0, both silently. The dialog's own
  // defaults were rescuing rows past the server's validation, so the messages
  // #2022 added were unreachable through the UI for exactly the fields that
  // matter most.

  it('does not send a row with a blank Name, and says why', async () => {
    const onImport = vi.fn().mockResolvedValue(result({ created: 1 }));
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV(['SKU,Name,Category,Sell Price', 'A-1,Hinge,Locksets,6.50', 'A-2,,Locksets,3.00'].join('\n'));

    await userEvent.click(await screen.findByRole('button', { name: /^Import 1 item$/i }));
    await waitFor(() => expect(onImport).toHaveBeenCalled());

    // Only the good row travelled - "Unnamed Item" never reaches the catalog.
    const sent = onImport.mock.calls[0][0] as Array<{ name: string }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.name).toBe('Hinge');
    expect(sent.some((i) => i.name === 'Unnamed Item')).toBe(false);

    const panel = (await screen.findByText(/Not imported/i)).closest('div')!;
    expect(within(panel).getByText('Row 3')).toBeInTheDocument();
    expect(within(panel).getByText(/Name is required/)).toBeInTheDocument();
  });

  it('does not turn an unreadable price into 0', async () => {
    const onImport = vi.fn().mockResolvedValue(result({ created: 1 }));
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV(['SKU,Name,Category,Sell Price', 'A-1,Hinge,Locksets,6.50', 'A-2,Panel,Locksets,ask us'].join('\n'));

    await userEvent.click(await screen.findByRole('button', { name: /^Import 1 item$/i }));
    await waitFor(() => expect(onImport).toHaveBeenCalled());

    const sent = onImport.mock.calls[0][0] as Array<{ sellPrice: number }>;
    expect(sent).toHaveLength(1);
    // A $0 item in a price book is worse than a rejected row.
    expect(sent.some((i) => i.sellPrice === 0)).toBe(false);
    expect(await screen.findByText(/Sell Price must be a number/)).toBeInTheDocument();
  });

  it('accepts a price written with a currency symbol and separators', async () => {
    const onImport = vi.fn().mockResolvedValue(result({ created: 1 }));
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV(['SKU,Name,Category,Sell Price', 'A-1,Hinge,Locksets,"$1,250.00"'].join('\n'));

    await userEvent.click(await screen.findByRole('button', { name: /^Import 1 item$/i }));
    await waitFor(() => expect(onImport).toHaveBeenCalled());
    expect((onImport.mock.calls[0][0] as Array<{ sellPrice: number }>)[0]!.sellPrice).toBe(1250);
  });

  it('reports a negative price rather than importing it', async () => {
    const onImport = vi.fn().mockResolvedValue(result({ created: 0 }));
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV(['SKU,Name,Category,Sell Price', 'A-1,Hinge,Locksets,-5'].join('\n'));

    await userEvent.click(await screen.findByRole('button', { name: /Import 0 items/i }));
    // Every row was held, so there is nothing worth a request.
    expect(onImport).not.toHaveBeenCalled();
    expect(await screen.findByText(/Sell Price cannot be negative/)).toBeInTheDocument();
  });

  it('counts only the rows it will actually send', async () => {
    render(<ImportCSVDialog open onClose={() => {}} onImport={() => {}} existingCategories={['Locksets']} />);
    // 4 data lines: one good, one blank line, one nameless, one priceless.
    dropCSV([
      'SKU,Name,Category,Sell Price',
      'A-1,Hinge,Locksets,6.50',
      '',
      'A-2,,Locksets,3.00',
      'A-3,Panel,Locksets,',
    ].join('\n'));

    // Not "Import 4 items" - the blank line and the two bad rows are not sent.
    expect(await screen.findByRole('button', { name: /^Import 1 item$/i })).toBeInTheDocument();
  });

  it('keeps held-back rows and server-rejected rows in one list, in line order', async () => {
    const onImport = vi.fn().mockResolvedValue(
      // The only row sent is A-3 (line 4), which the server rejects.
      result({ created: 0, errors: [{ index: 0, message: 'An item with this SKU already exists' }] }),
    );
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV([
      'SKU,Name,Category,Sell Price',
      'A-2,,Locksets,3.00',
      'A-3,Panel,Locksets,9.00',
    ].join('\n'));

    await userEvent.click(await screen.findByRole('button', { name: /^Import 1 item$/i }));
    const panel = (await screen.findByText(/Not imported \(2\)/i)).closest('div')!;
    const lines = within(panel).getAllByText(/^Row \d+$/).map((n) => n.textContent);
    expect(lines).toEqual(['Row 2', 'Row 3']);
  });
});

describe('ImportCSVDialog — issue report', () => {
  it('stays open after the import instead of closing on a count', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn().mockResolvedValue(result({ created: 2, errors: [{ index: 1, message: 'Name is required' }] }));
    render(<ImportCSVDialog open onClose={onClose} onImport={onImport} existingCategories={['Locksets']} />);
    dropCSV(THREE_ROWS);
    await userEvent.click(await screen.findByRole('button', { name: /^Import 3 items/i }));

    await screen.findByText(/Not imported/i);
    // Closing here would take the only copy of the diagnosis with it.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('names the spreadsheet line, not the array index', async () => {
    // index 1 is the SECOND data row, which is line 3 of the file (header is 1).
    await importAndGetPanel(THREE_ROWS, result({ created: 2, errors: [{ index: 1, message: 'Sell Price must be a number' }] }));

    const panel = (await screen.findByText(/Not imported/i)).closest('div')!;
    expect(within(panel).getByText('Row 3')).toBeInTheDocument();
    expect(within(panel).getByText(/Sell Price must be a number/)).toBeInTheDocument();
    // The row's own SKU, so it is findable even after the file is re-sorted.
    expect(within(panel).getByText('A-2')).toBeInTheDocument();
  });

  it('keeps line numbers honest when the file has a blank line in the middle', async () => {
    const withBlank = [
      'SKU,Name,Category,Sell Price',
      'A-1,Hinge,Locksets,6.50',
      '',
      'A-3,Screw,Locksets,1.00',
    ].join('\n');
    // The blank line is dropped, so the surviving rows are A-1 and A-3 at
    // indexes 0 and 1 - but A-3 is line 4 of the operator's file, not line 3.
    const onImport = await importAndGetPanel(withBlank, result({ created: 1, errors: [{ index: 1, message: 'Name is required' }] }));

    expect((onImport.mock.calls[0][0] as unknown[]).length).toBe(2);
    const panel = (await screen.findByText(/Not imported/i)).closest('div')!;
    expect(within(panel).getByText('Row 4')).toBeInTheDocument();
    expect(within(panel).queryByText('Row 3')).toBeNull();
  });

  it('separates rows that were rejected from rows that merely lost their vendor', async () => {
    await importAndGetPanel(
      THREE_ROWS,
      result({
        created: 2,
        errors: [{ index: 0, message: 'An item with this SKU already exists' }],
        warnings: [{ index: 2, message: 'Vendor "Blum Inc" not found - left blank' }],
      }),
    );

    const rejected = (await screen.findByText(/Not imported \(1\)/i)).closest('div')!;
    expect(within(rejected).getByText(/SKU already exists/)).toBeInTheDocument();
    // A warned row IS in the catalog; listing it under "not imported" would send
    // the operator to re-import a row that is already there.
    expect(within(rejected).queryByText(/Blum Inc/)).toBeNull();

    const flagged = (await screen.findByText(/Imported, but check these \(1\)/i)).closest('div')!;
    expect(within(flagged).getByText(/Blum Inc/)).toBeInTheDocument();
  });

  it('tells the operator to fix the file and import it again', async () => {
    await importAndGetPanel(THREE_ROWS, result({ created: 2, errors: [{ index: 1, message: 'Name is required' }] }));
    expect(await screen.findByText(/fix these rows and import the file again/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import Another File/i })).toBeInTheDocument();
  });

  it('reports the categories it created, by name', async () => {
    await importAndGetPanel(THREE_ROWS, result({ created: 3, createdCategories: ['Hinges', 'Panels'] }));
    expect(await screen.findByText(/created 2 new categories: Hinges, Panels/i)).toBeInTheDocument();
  });

  it('says so plainly when nothing needs fixing', async () => {
    await importAndGetPanel(THREE_ROWS, result({ created: 3 }));
    expect(await screen.findByText(/Every row went in cleanly/i)).toBeInTheDocument();
  });

  it('explains a whole-request failure instead of closing silently', async () => {
    const onClose = vi.fn();
    const onImport = vi.fn().mockRejectedValue({ response: { data: { error: 'File is too large' } } });
    render(<ImportCSVDialog open onClose={onClose} onImport={onImport} existingCategories={[]} />);
    dropCSV(THREE_ROWS);
    await userEvent.click(await screen.findByRole('button', { name: /^Import 3 items/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Nothing was imported/i);
    expect(alert).toHaveTextContent(/File is too large/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a caller that returns nothing keeps the old close-immediately behaviour', async () => {
    const onClose = vi.fn();
    render(<ImportCSVDialog open onClose={onClose} onImport={() => {}} existingCategories={[]} />);
    dropCSV(THREE_ROWS);
    await userEvent.click(await screen.findByRole('button', { name: /^Import 3 items/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Not imported/i)).toBeNull();
  });
});
