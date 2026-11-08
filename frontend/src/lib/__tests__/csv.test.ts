import { describe, it, expect, vi, afterEach } from 'vitest';
import { csvField, toCSVRows, toCSV, downloadCSV, exportCsvFile } from '../csv';

describe('csvField', () => {
  it('leaves plain values unquoted', () => {
    expect(csvField('Residential')).toBe('Residential');
    expect(csvField(42)).toBe('42');
  });

  it('renders null and undefined as an empty field', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes fields containing a comma', () => {
    expect(csvField('Imperiali, Ron & Rebecca')).toBe('"Imperiali, Ron & Rebecca"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvField('Honan, Ellen ("Ivory & Bone")')).toBe('"Honan, Ellen (""Ivory & Bone"")"');
  });

  it('quotes fields containing newlines', () => {
    expect(csvField('line one\nline two')).toBe('"line one\nline two"');
    expect(csvField('line one\r\nline two')).toBe('"line one\r\nline two"');
  });
});

describe('toCSVRows', () => {
  it('escapes the header as well as the body', () => {
    expect(toCSVRows(['Name, Full', 'Balance'], [['Smith', 10]])).toBe('"Name, Full",Balance\r\nSmith,10');
  });

  it('joins records with CRLF', () => {
    expect(toCSVRows(['A'], [['x'], ['y']])).toBe('A\r\nx\r\ny');
  });

  // The exact shape that broke for Lakeside: a comma in the customer name plus a
  // comma in the date pushed every following value one column right.
  it('keeps column count stable when names and dates contain commas', () => {
    const header = ['Customer', 'Type', 'Location', 'Invoice', 'Invoice date', 'Bucket', 'Days Late', 'Balance', 'Next Action'];
    const rows = [
      ['Dorfman, Josh, Chaletzky, Blair &', 'Residential', '—', 'I00203', 'May 1, 26', '31-60', 46, 31500, 'Call'],
      ['Construction Operations Group- 13 Merrimac', 'Residential', '—', 'I00163', 'Jan 12, 26', '121+', 155, 21490, 'Collections'],
    ];

    const topLevelCommas = (line: string) => {
      let inQuotes = false;
      let n = 0;
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes;
        else if (ch === ',' && !inQuotes) n++;
      }
      return n;
    };

    const lines = toCSVRows(header, rows).split('\r\n');
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(topLevelCommas(line)).toBe(8);
  });
});

describe('toCSV', () => {
  it('returns an empty string for no rows', () => {
    expect(toCSV([])).toBe('');
  });

  it('builds headers from the union of keys', () => {
    expect(toCSV([{ a: 1 }, { b: 2 }])).toBe('a,b\r\n1,\r\n,2');
  });
});

describe('downloadCSV', () => {
  afterEach(() => vi.restoreAllMocks());

  // spyOn needs a real constructor to stand in for `new Blob(...)`, so this is a
  // function expression (not an arrow) delegating to the captured original.
  function spyBlob() {
    const calls: { parts: unknown[]; opts?: BlobPropertyBag }[] = [];
    const OriginalBlob = global.Blob;
    vi.spyOn(global, 'Blob').mockImplementation(function (
      this: unknown, parts?: BlobPart[], opts?: BlobPropertyBag,
    ) {
      calls.push({ parts: parts ?? [], opts });
      return new OriginalBlob(parts ?? [], opts);
    } as unknown as typeof Blob);
    return calls;
  }

  it('prepends a UTF-8 BOM and triggers exactly one download', () => {
    const calls = spyBlob();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCSV('A,B\r\n1,2', 'test.csv');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.parts[0]).toBe('﻿A,B\r\n1,2');
    expect(calls[0]!.opts?.type).toContain('text/csv');
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('escapes end-to-end via exportCsvFile', () => {
    const calls = spyBlob();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    exportCsvFile('x.csv', ['Customer', 'Balance'], [['Smith, John', 100]]);

    expect(calls[0]!.parts[0]).toBe('﻿Customer,Balance\r\n"Smith, John",100');
  });
});
