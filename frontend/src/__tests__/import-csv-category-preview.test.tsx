import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportCSVDialog } from '@/components/inventory/ImportCSVDialog';

// The dialog reaches the browser's download through this seam; jsdom cannot
// perform one, so spy on the seam rather than the anchor click.
const downloadCSV = vi.fn();
vi.mock('@/lib/inventory/csv', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/inventory/csv')>()),
  downloadCSV: (...args: unknown[]) => downloadCSV(...args),
}));

// Unmatched CATEGORY names are created by the importer; unmatched VENDOR names
// are not. That makes the dialog the last cheap place to catch a typo, so it
// previews the categories the file would create BEFORE anything is sent.
//
// It also makes the payload's blank-cell handling load-bearing: the dialog used
// to substitute "Uncategorized" and an em dash for empty Category/Vendor cells,
// which under name matching would create a category called "Uncategorized" on
// the very first import and report the dash as an unknown vendor once per row.

function dropCSV(text: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([text], 'catalog.csv', { type: 'text/csv' });
  // jsdom's FileList is read-only; define the property the handler reads.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

const WITH_CATEGORIES = [
  'SKU,Name,Category,Sell Price',
  'A-1,Hinge,Hardware,6.50',
  'A-2,Panel,Hinges,9.00',
  'A-3,Screw,hinges,1.00',
].join('\n');

beforeEach(() => downloadCSV.mockClear());

describe('ImportCSVDialog — sample CSV template', () => {
  // Ran, 2026-09-08: "not every CSV can be imported because there will be
  // conflicts... maybe we can have another button to download a CSV example, so
  // they'll know what we expect". The download is the answer to that, and it has
  // to be reachable WITHOUT opening the disclosure - someone who does not know
  // what we expect will not expand a collapsed panel to find out.
  it('offers the download on the drop screen, before any file is chosen', () => {
    render(<ImportCSVDialog open onClose={() => {}} onImport={() => {}} existingCategories={[]} />);
    const button = screen.getByRole('button', { name: /download sample csv/i });
    expect(button).toBeInTheDocument();
    // Not nested inside the <details>, or it would be hidden until expanded.
    expect(button.closest('details')).toBeNull();
  });

  it('downloads exactly what the preview shows, so the two cannot drift', async () => {
    render(<ImportCSVDialog open onClose={() => {}} onImport={() => {}} existingCategories={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /download sample csv/i }));

    expect(downloadCSV).toHaveBeenCalledTimes(1);
    const [csv, filename] = downloadCSV.mock.calls[0] as [string, string];
    expect(filename).toMatch(/\.csv$/);

    const previewed = (document.querySelector('details pre')?.textContent ?? '').trim();
    expect(previewed).not.toBe('');
    expect(csv.trim()).toBe(previewed);
  });

  it('the template auto-maps end to end, so it never lands on the mapping step', async () => {
    const onImport = vi.fn();
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={[]} />);
    await userEvent.click(screen.getByRole('button', { name: /download sample csv/i }));
    const [csv] = downloadCSV.mock.calls[0] as [string];

    // Feed the file we just handed the customer straight back in.
    dropCSV(csv);
    const submit = await screen.findByRole('button', { name: /Import 2 items/i });
    await userEvent.click(submit);

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const [items] = onImport.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(items).toHaveLength(2);
    // Every column landed - a header we cannot auto-map would blank one of these.
    expect(items[0]).toMatchObject({ sku: 'LCK-NEW-001', category: 'Locksets', vendor: 'ASA / Mul-T-Lock NA', kind: 'material', uom: 'EA' });
    expect(items[0]!.sellPrice).toBe(108);
    expect(items[0]!.unitCost).toBe(42);
  });
});

describe('ImportCSVDialog — no unbacked AI claims', () => {
  // Two of these shipped: a checked-by-default "AI auto-categorize" toggle wired
  // to nothing, and a subtitle promising "AI categorization runs after import".
  // Both described a feature that does not exist, and the second outlived the
  // first because removing the toggle did not touch the modal's subtitle. Once
  // the importer began matching Category by name they also contradicted the
  // panel that states the real rule. Pin the whole dialog, not one string.
  it('promises no AI categorization anywhere in the dialog', async () => {
    render(<ImportCSVDialog open onClose={() => {}} onImport={() => {}} existingCategories={[]} />);
    dropCSV(WITH_CATEGORIES);
    await screen.findByText(/Column mapping/i);

    expect(document.body.textContent).not.toMatch(/\bAI\b/);
    expect(document.body.textContent).not.toMatch(/auto-categoriz/i);
    expect(document.body.textContent).not.toMatch(/review queue/i);
  });
});

describe('ImportCSVDialog — category creation preview', () => {
  it('names the categories the file would create, and not the ones that exist', async () => {
    render(
      <ImportCSVDialog open onClose={() => {}} onImport={() => {}} existingCategories={['Hardware']} />,
    );
    dropCSV(WITH_CATEGORIES);

    const note = await screen.findByText(/will create/i);
    // "Hinges" and "hinges" are one category, and Hardware already exists.
    expect(note).toHaveTextContent('1 new category');
    expect(note).toHaveTextContent('Hinges');
    expect(note.textContent).not.toContain('Hardware');
  });

  it('says nothing about creating categories when every name already exists', async () => {
    render(
      <ImportCSVDialog
        open
        onClose={() => {}}
        onImport={() => {}}
        existingCategories={['Hardware', 'Hinges']}
      />,
    );
    dropCSV(WITH_CATEGORIES);

    await screen.findByText(/Column mapping/i);
    expect(screen.queryByText(/will create/i)).toBeNull();
  });

  it('matches the existing name case-insensitively, so a case variant creates nothing', async () => {
    render(
      <ImportCSVDialog
        open
        onClose={() => {}}
        onImport={() => {}}
        existingCategories={['  hardware ', 'HINGES']}
      />,
    );
    dropCSV(WITH_CATEGORIES);

    await screen.findByText(/Column mapping/i);
    expect(screen.queryByText(/will create/i)).toBeNull();
  });

  it('sends a blank Category and Vendor as blank, never as a placeholder', async () => {
    const onImport = vi.fn();
    render(<ImportCSVDialog open onClose={() => {}} onImport={onImport} existingCategories={[]} />);
    // No Category and no Vendor column at all - the common first import.
    dropCSV(['SKU,Name,Sell Price', 'A-1,Hinge,6.50'].join('\n'));

    const submit = await screen.findByRole('button', { name: /Import 1 item/i });
    await userEvent.click(submit);

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    const [items] = onImport.mock.calls[0] as [Array<{ category: string; vendor: string }>];
    // A placeholder here would have the server CREATE a category named
    // "Uncategorized" and report the vendor dash as unknown on every row.
    expect(items[0]!.category).toBe('');
    expect(items[0]!.vendor).toBe('');
  });
});
