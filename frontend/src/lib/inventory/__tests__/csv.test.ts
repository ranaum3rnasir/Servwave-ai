import { describe, it, expect, vi, afterEach } from "vitest";
import { toCSV, downloadCSV } from "@/lib/inventory/csv";

describe("toCSV", () => {
  it("returns an empty string for no rows", () => {
    expect(toCSV([])).toBe("");
  });

  it("emits a header row from the union of keys", () => {
    const csv = toCSV([{ a: 1, b: 2 }]);
    expect(csv.split("\r\n")[0]).toBe("a,b");
  });

  it("joins rows with CRLF", () => {
    const csv = toCSV([{ a: 1 }, { a: 2 }]);
    expect(csv).toBe("a\r\n1\r\n2");
  });

  it("wraps a field containing a comma in double quotes", () => {
    const csv = toCSV([{ name: "Smith, Inc." }]);
    expect(csv).toBe('name\r\n"Smith, Inc."');
  });

  it("escapes a double-quote by doubling it and wraps the field", () => {
    const csv = toCSV([{ note: 'say "hi"' }]);
    expect(csv).toBe('note\r\n"say ""hi"""');
  });

  it("wraps a field containing a newline in double quotes", () => {
    const csv = toCSV([{ addr: "line1\nline2" }]);
    expect(csv).toBe('addr\r\n"line1\nline2"');
  });

  it("wraps a field containing a carriage return in double quotes", () => {
    const csv = toCSV([{ addr: "line1\r\nline2" }]);
    expect(csv).toBe('addr\r\n"line1\r\nline2"');
  });

  it("renders null and undefined as empty fields", () => {
    const csv = toCSV([{ a: null, b: undefined }]);
    expect(csv).toBe("a,b\r\n,");
  });

  it("does not quote a plain value with no special chars", () => {
    const csv = toCSV([{ a: "plain" }]);
    expect(csv).toBe("a\r\nplain");
  });
});

describe("downloadCSV", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prepends a UTF-8 BOM, builds a Blob, and triggers a download click", () => {
    const csv = "a,b\r\n1,2";
    const blobCalls: { parts: BlobPart[]; opts?: BlobPropertyBag }[] = [];
    const OriginalBlob = global.Blob;
    // Capture the Blob constructed inside downloadCSV. spyOn needs a real
    // constructor (not an arrow fn) to stand in for `new Blob(...)`.
    const blobSpy = vi
      .spyOn(global, "Blob")
      .mockImplementation(function (
        this: unknown,
        parts?: BlobPart[],
        opts?: BlobPropertyBag,
      ) {
        blobCalls.push({ parts: parts ?? [], opts });
        return new OriginalBlob(parts, opts);
      } as unknown as typeof Blob);

    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});

    downloadCSV(csv, "test.csv");

    // A Blob was constructed with the UTF-8 BOM prepended.
    expect(blobSpy).toHaveBeenCalledTimes(1);
    expect(blobCalls).toHaveLength(1);
    expect((blobCalls[0]!.parts as string[])[0]).toBe("﻿" + csv);
    expect(blobCalls[0]!.opts?.type).toContain("text/csv");

    // Download was triggered (object URL created + anchor clicked).
    expect(createUrlSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
