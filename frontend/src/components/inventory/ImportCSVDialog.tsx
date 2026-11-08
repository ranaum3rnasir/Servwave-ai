import { useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  AlertCircle,
  Download,
  FileText,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { SelectField } from "@/components/form/SelectField";
import { autoMapColumns, downloadCSV, parseCSV, type ParsedCSV } from "@/lib/inventory/csv";
import { importIssues, type ImportIssue, type ImportRowRef } from "@/lib/inventory/import-summary";
import type { ImportItemsResult } from "@/lib/api/inventory";
import { extractApiError } from "@/lib/utils";
import type { NewItem } from "@/components/inventory/AddItemDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  open: boolean;
  onClose: () => void;
  /**
   * Persist the rows. RESOLVE with the API's result and this dialog stays open
   * to show what happened, row by row; REJECT and it shows the failure. A
   * caller that returns nothing keeps the old fire-and-close behaviour and owns
   * its own feedback.
   */
  onImport: (items: NewItem[]) => void | Promise<ImportItemsResult | void>;
  /**
   * Names of the categories the org already has. Used only to preview which
   * ones this file would CREATE - the server does its own matching and is the
   * authority. Optional so a caller that has not loaded them yet still renders.
   */
  existingCategories?: string[];
};

type Mapping = {
  sku: string | null;
  name: string | null;
  category: string | null;
  kind: string | null;
  uom: string | null;
  unitCost: string | null;
  sellPrice: string | null;
  vendor: string | null;
  mpn: string | null;
  upc: string | null;
  serialized: string | null;
  hazmat: string | null;
};

/**
 * The sample the dialog shows AND the file the Download button hands over -
 * one constant so the two can never drift. Its header row is pinned against
 * docs/inventory/catalog-import-template.csv by catalog-import-template.test.tsx.
 *
 * Every column here auto-maps, so a customer who starts from this file never
 * has to touch the mapping step. Category and Vendor are matched by name:
 * a category that does not exist is created, a vendor that does not exist is
 * reported and left blank - which is why the two example rows name a realistic
 * category and vendor rather than placeholders.
 */
const SAMPLE_CSV = `SKU,Name,Category,Kind,UoM,Unit Cost,Sell Price,Vendor
LCK-NEW-001,Schlage B60 Deadbolt,Locksets,material,EA,42.00,108.00,ASA / Mul-T-Lock NA
HVC-CAP-30-5,Run Capacitor 30/5 MFD,Capacitors,material,EA,9.50,32.00,Ferguson HVAC`;

const REQUIRED_FIELDS: (keyof Mapping)[] = ["name"];

/** Stands in for the response we never asked for when every row was held back. */
const EMPTY_RESULT = { created: 0, updated: 0, errors: [], warnings: [], createdCategories: [] };

const FIELD_LABELS: Record<keyof Mapping, string> = {
  sku: "SKU",
  name: "Item Name",
  category: "Category",
  kind: "Kind",
  uom: "UoM",
  unitCost: "Unit Cost",
  sellPrice: "Sell Price",
  vendor: "Vendor",
  mpn: "MPN",
  upc: "UPC",
  serialized: "Serialized",
  hazmat: "Hazmat",
};

/**
 * The list the operator works from: one line per problem, each naming the row in
 * THEIR file. Scrolls rather than growing, because a bad export can produce a
 * problem on every row and the footer buttons must stay reachable.
 */
function IssueList({
  tone,
  title,
  issues,
}: {
  tone: "danger" | "warning";
  title: string;
  issues: ImportIssue[];
}) {
  const ring = tone === "danger" ? "border-danger/30" : "border-warning/30";
  const head = tone === "danger" ? "text-danger" : "text-warning";
  return (
    <div className={`rounded-md border ${ring}`}>
      <p className={`border-b ${ring} px-3 py-2 text-xs font-semibold ${head}`}>{title}</p>
      <ul className="max-h-56 divide-y divide-border overflow-y-auto">
        {issues.map((issue) => (
          <li key={`${issue.line}-${issue.message}`} className="flex gap-2 px-3 py-1.5 text-xs">
            <span className="w-16 flex-shrink-0 font-mono text-text-secondary">Row {issue.line}</span>
            {issue.label && (
              <span className="max-w-[12rem] flex-shrink-0 truncate font-medium text-text-primary">
                {issue.label}
              </span>
            )}
            <span className="text-text-secondary">{issue.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ImportCSVDialog({ open, onClose, onImport, existingCategories }: Props) {
  const [parsed, setParsed] = useState<ParsedCSV | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The outcome of the last import, plus the row mapping it was sent with, so
  // the server's row INDEXES can be named as spreadsheet LINES.
  const [outcome, setOutcome] = useState<
    { result: ImportItemsResult; rows: ImportRowRef[]; held: ImportIssue[] } | null
  >(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setParsed(null);
    setFileName(null);
    setMapping(null);
    setError(null);
    setDragOver(false);
    setOutcome(null);
    setFailure(null);
    setSubmitting(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleFile(file: File | null | undefined) {
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setError("Please drop a .csv file.");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("CSV is over 20 MB — bulk imports of that size go through the back-office importer.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const p = parseCSV(text);
      if (p.headers.length === 0 || p.rows.length === 0) {
        setError("Could not find any data rows in this CSV.");
        return;
      }
      setParsed(p);
      setFileName(file.name);
      const auto = autoMapColumns(p.headers);
      setMapping(auto as Mapping);
      setError(null);
    };
    reader.onerror = () => setError("Failed to read the file.");
    reader.readAsText(file);
  }

  function updateMapping(field: keyof Mapping, value: string) {
    setMapping((m) =>
      m ? { ...m, [field]: value === "__none__" ? null : value } : m,
    );
  }

  /**
   * The rows to send, each paired with the line it came from in the operator's
   * file (header is line 1) and a label to recognise it by. The pairing is what
   * lets the result name a line rather than an array index.
   *
   * Fully blank lines are DROPPED, not sent: a trailing newline in the middle
   * of a file would otherwise come back as "Name is required" against a line
   * the operator never filled in.
   */
  function buildRows(): { item: NewItem; line: number; label: string; problems: string[] }[] {
    if (!parsed || !mapping) return [];
    // Item Kind is material|service. The three retired tokens are still ACCEPTED
    // from a CSV - a spreadsheet written last month should not fail to import -
    // but they land on `service`, which is how all three already billed. Any
    // other value keeps the long-standing "material" fallback below.
    const RETIRED_KINDS: Record<string, string> = { labor: "service", bundle: "service", fee: "service" };
    const kindAllowed = new Set(["material", "service"]);
    const built: { item: NewItem; line: number; label: string; problems: string[] }[] = [];
    parsed.rows.forEach((r, rowIndex) => {
      const get = (k: keyof Mapping) =>
        mapping[k] ? r[mapping[k] as string] ?? "" : "";
      // Blank across every column we actually read.
      if (Object.keys(FIELD_LABELS).every((k) => get(k as keyof Mapping).trim() === "")) return;
      const kind = get("kind").toLowerCase();
      const serializedRaw = get("serialized").toLowerCase();
      const hazmatRaw = get("hazmat").toLowerCase();
      // The three fields the server validates are NOT defaulted here. Filling a
      // blank Name with "Unnamed Item" or a bad price with 0 does not rescue the
      // row, it hides it: the value passes validation and lands in the catalog
      // with nobody told. Collect the problems instead and report them.
      const rawName = get("name").trim();
      const problems: string[] = [];
      if (rawName === "") problems.push("Name is required");

      const money = (key: "unitCost" | "sellPrice", label: string, required: boolean) => {
        const raw = get(key).trim();
        if (raw === "") {
          if (required) problems.push(`${label} is required`);
          return 0;
        }
        const n = Number(raw.replace(/[$,]/g, ""));
        if (!Number.isFinite(n)) problems.push(`${label} must be a number`);
        else if (n < 0) problems.push(`${label} cannot be negative`);
        return Number.isFinite(n) ? n : 0;
      };
      const unitCost = money("unitCost", "Unit Cost", false);
      const sellPrice = money("sellPrice", "Sell Price", true);

      const item = {
        sku: get("sku").trim(),
        name: rawName,
        // No placeholder. These two are name-matched server-side, and a blank
        // cell must arrive blank: "Uncategorized" would have the importer
        // CREATE a category by that name on the very first import, and the
        // vendor dash would be reported unmatched once per row.
        category: get("category").trim(),
        trade: "general",
        kind: RETIRED_KINDS[kind] ?? (kindAllowed.has(kind) ? kind : "material"),
        uom: get("uom").trim() || "EA",
        unitCost,
        sellPrice,
        serialized: ["y", "yes", "true", "1"].includes(serializedRaw),
        hazmat: ["y", "yes", "true", "1"].includes(hazmatRaw),
        // CSV import never opts an item into stock tracking (Inventory P1 D8 default).
        trackInventory: false,
        vendor: get("vendor").trim(),
        startingStock: [],
      };
      built.push({
        item,
        // +2: the header occupies line 1, and rowIndex is 0-based.
        line: rowIndex + 2,
        label: item.sku || rawName,
        problems,
      });
    });
    return built;
  }

  const missingRequired = mapping
    ? REQUIRED_FIELDS.filter((f) => !mapping[f])
    : [];

  // The rows that would actually be SENT. `parsed.rows.length` counts blank
  // lines and rows we already know are invalid, so labelling the button with it
  // promises an import that will not happen.
  const sendableCount = parsed && mapping
    ? buildRows().filter((r) => r.problems.length === 0).length
    : 0;

  // The categories this file would create, in first-seen order and de-duplicated
  // the way the server does it (trimmed, case-insensitive). Computed on render
  // like missingRequired above, not memoised - it is one pass over a CSV the
  // operator just dropped, and it has to follow every mapping change anyway.
  //
  // A PREVIEW, not a promise: the server matches against live data and may find
  // a category this list thinks is new. Being one row stale here is harmless;
  // the point is that a typo is visible while it is still free to fix.
  const newCategories: string[] = [];
  if (parsed && mapping?.category) {
    const column = mapping.category;
    const known = new Set((existingCategories ?? []).map((n) => n.trim().toLowerCase()));
    for (const row of parsed.rows) {
      const name = (row[column] ?? "").trim();
      if (name === "") continue;
      const key = name.toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      newCategories.push(name);
    }
  }

  async function submit() {
    const rows = buildRows();
    if (rows.length === 0) {
      setError("Nothing to import.");
      return;
    }
    // Rows we already know the server would reject are held back rather than
    // sent: the round trip cannot tell the operator anything we do not already
    // know, and a rejected row is indistinguishable from a saved one once the
    // dialog closes.
    const sendable = rows.filter((r) => r.problems.length === 0);
    const held: ImportIssue[] = rows
      .filter((r) => r.problems.length > 0)
      .flatMap((r) => r.problems.map((message) => ({ line: r.line, label: r.label, message })));

    if (sendable.length === 0) {
      // Nothing worth a request. Report and stop.
      setError(null);
      setOutcome({ result: EMPTY_RESULT, rows: [], held });
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      const result = await onImport(sendable.map((r) => r.item));
      if (!result) {
        // Caller owns its own feedback (the pre-result contract). Behave as before.
        reset();
        onClose();
        return;
      }
      // `rows` here is `sendable`: the server indexes the array it was sent.
      setOutcome({ result, rows: sendable, held });
    } catch (err) {
      setFailure(extractApiError(err, "check the file and try again"));
    } finally {
      setSubmitting(false);
    }
  }

  // Held-back rows and server-rejected rows are the same thing to the operator -
  // a row that is not in the catalog and needs an edit - so they share one list,
  // ordered by the line they came from.
  const rejected: ImportIssue[] = outcome
    ? [...outcome.held, ...importIssues(outcome.result.errors, outcome.rows)].sort((a, b) => a.line - b.line)
    : [];
  const flagged: ImportIssue[] = outcome ? importIssues(outcome.result.warnings, outcome.rows) : [];

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import Items from CSV"
      size="xl"
      footer={
        outcome || failure ? (
          <>
            <Button variant="outline" size="sm" onClick={reset}>
              Import Another File
            </Button>
            <Button size="sm" onClick={() => { reset(); onClose(); }}>
              Done
            </Button>
          </>
        ) : parsed ? (
          <>
            <Button variant="outline" size="sm"
              onClick={() => {
                reset();
              }}
            >
              Choose Different File
            </Button>
            <Button size="sm"
              onClick={() => { void submit(); }}
              disabled={missingRequired.length > 0 || submitting}
            >
              {submitting
                ? "Importing…"
                : `Import ${sendableCount} item${sendableCount === 1 ? "" : "s"}`}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
        )
      }
    >
      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {outcome || failure ? (
        <div className="flex flex-col gap-4">
          {failure ? (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>Nothing was imported — {failure}</span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
              <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>
                Imported <strong>{outcome!.result.created}</strong> new and updated{" "}
                <strong>{outcome!.result.updated}</strong>
                {(outcome!.result.createdCategories ?? []).length > 0 && (
                  <>
                    {" · created "}
                    {(outcome!.result.createdCategories ?? []).length} new categor
                    {(outcome!.result.createdCategories ?? []).length === 1 ? "y" : "ies"}:{" "}
                    {(outcome!.result.createdCategories ?? []).join(", ")}
                  </>
                )}
              </span>
            </div>
          )}

          {/* Rejected rows first: these are the ones the operator has to act on
              before anything of theirs exists in the catalog. */}
          {rejected.length > 0 && (
            <IssueList
              tone="danger"
              title={`Not imported (${rejected.length}) — fix these rows and import the file again`}
              issues={rejected}
            />
          )}

          {flagged.length > 0 && (
            <IssueList
              tone="warning"
              title={`Imported, but check these (${flagged.length})`}
              issues={flagged}
            />
          )}

          {!failure && rejected.length === 0 && flagged.length === 0 && (
            <p className="text-xs text-text-secondary">
              Every row went in cleanly. Nothing to fix.
            </p>
          )}
        </div>
      ) : !parsed ? (
        <div className="flex flex-col gap-3">
          {/* File-drop zone - the whole area IS the control (no visible input
              box, drop target doubles as the click target), the shape
              FormField's own header comment names as not covered by this
              pattern. Left raw. */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              handleFile(e.dataTransfer.files?.[0]);
            }}
            className={[
              "flex h-56 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed text-center transition",
              dragOver
                ? "border-primary bg-primary-subtle"
                : "border-border bg-background-light hover:border-primary hover:bg-primary-subtle/40",
            ].join(" ")}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary-subtle">
              <Upload className="h-5 w-5 text-primary" />
            </div>
            <p className="text-sm font-semibold text-text-primary">
              Drop CSV here, or click to choose
            </p>
            <p className="text-xs text-text-secondary">
              Up to 20 MB · UTF-8 encoded · header row required
            </p>
            <Input
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>

          <div className="rounded-md border border-border bg-background-light/40 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Expected columns (any reasonable header — we'll auto-map)
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(FIELD_LABELS).map(([k, label]) => (
                <span
                  key={k}
                  className={[
                    "rounded-md px-2 py-0.5 text-[11px] ring-1",
                    REQUIRED_FIELDS.includes(k as keyof Mapping)
                      ? "bg-primary-subtle text-primary ring-primary/20"
                      : "bg-surface-light text-text-secondary ring-border",
                  ].join(" ")}
                >
                  {label}
                  {REQUIRED_FIELDS.includes(k as keyof Mapping) && (
                    <span className="ml-0.5 text-danger">*</span>
                  )}
                </span>
              ))}
            </div>
          </div>

          {/* The download sits OUTSIDE the disclosure on purpose: a customer who
              does not already know what we expect will not open a collapsed
              panel to find out. Starting from this file is what keeps a CSV
              off the mapping step entirely. */}
          <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-text-secondary">
                Not sure what we expect? Start from our template.
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadCSV(SAMPLE_CSV, "servwave-catalog-import-template.csv")}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download sample CSV
              </Button>
            </div>
            <details>
              <summary className="cursor-pointer font-medium text-text-secondary">
                Or preview it here
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-background-dark p-2 text-[10px] text-on-fill/90">
{SAMPLE_CSV}
              </pre>
            </details>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* File summary */}
          <div className="flex items-center justify-between rounded-md border border-success/20 bg-success/10 px-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-success" />
              <span className="font-mono text-xs text-success">{fileName}</span>
              <span className="text-success">·</span>
              <span className="text-xs text-success">
                {parsed.rows.length} rows · {parsed.headers.length} columns
              </span>
            </div>
            {/* Raw by design: no `success` tone is minted on Button (see
                button.tsx header note - deferred, zero measured call sites);
                a small icon-dismiss affordance inside a status banner. */}
            <button
              onClick={reset}
              className="rounded p-1 text-success hover:bg-success/10"
              title="Choose a different file"
              aria-label="Reset"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Column mapping */}
          <div>
            {/* Raw by design: bracket size text-[11px] has no matching Heading scale key. */}
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Column mapping
              <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-primary-subtle px-1.5 py-0.5 text-[10px] font-medium normal-case text-primary ring-1 ring-primary/20">
                <Sparkles className="h-2.5 w-2.5" />
                Auto-detected — review + override
              </span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-2 rounded-md border border-border bg-background-light/40 p-3">
              {Object.entries(FIELD_LABELS).map(([k, label]) => {
                const field = k as keyof Mapping;
                const required = REQUIRED_FIELDS.includes(field);
                const value = mapping?.[field];
                const ok = !!value;
                return (
                  <div key={k} className="flex items-center gap-2">
                    <div className="flex-shrink-0 basis-28 text-xs">
                      <span className="font-medium text-text-secondary">{label}</span>
                      {required && <span className="ml-0.5 text-danger">*</span>}
                    </div>
                    <SelectField
                      aria-label={label}
                      value={value ?? "__none__"}
                      onValueChange={(v) => updateMapping(field, v)}
                      className={[
                        "flex-1 rounded-md border bg-surface-light px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary-subtle",
                        required && !ok
                          ? "border-danger/20"
                          : ok
                            ? "border-success/20"
                            : "border-border",
                      ].join(" ")}
                      options={[
                        { value: "__none__", label: "— not mapped —" },
                        ...parsed.headers.map((h) => ({ value: h, label: h })),
                      ]}
                    />
                    {ok && (
                      <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />
                    )}
                  </div>
                );
              })}
            </div>
            {missingRequired.length > 0 && (
              <p className="mt-1.5 text-[11px] text-danger">
                Map {missingRequired.map((f) => FIELD_LABELS[f]).join(", ")}{" "}
                before importing.
              </p>
            )}
          </div>

          {/* Preview */}
          <div>
            {/* Raw by design: bracket size text-[11px] has no matching Heading scale key. */}
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              Preview · first 5 rows
            </h3>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="min-w-full text-xs">
                <thead className="bg-background-light">
                  <tr>
                    {parsed.headers.map((h) => (
                      <th
                        key={h}
                        className="border-b border-border px-2 py-1.5 text-left font-medium text-text-secondary"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.rows.slice(0, 5).map((r, idx) => (
                    <tr key={idx} className="border-t border-border">
                      {parsed.headers.map((h) => (
                        <td
                          key={h}
                          className="max-w-[180px] truncate px-2 py-1 text-text-secondary"
                          title={r[h]}
                        >
                          {r[h]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Replaces a checked-by-default "AI auto-categorize" toggle that was
              wired to nothing: no request carried it and no review queue existed.
              What stands here instead is the rule the server actually follows,
              plus the one thing worth seeing BEFORE the import runs - the
              categories it is about to create. */}
          <div className="rounded-md border border-primary/20 bg-primary-subtle/60 px-3 py-2 text-xs text-text-primary">
            <p>
              <strong>Category and Vendor are matched by name</strong> against what you already
              have — case and spacing do not matter. A vendor that is not found is reported after
              the import and that item arrives with no vendor; vendors are never created here.
            </p>
            {newCategories.length > 0 && (
              <p className="mt-1.5 border-t border-primary/20 pt-1.5">
                This file will create{" "}
                <strong>
                  {newCategories.length} new categor{newCategories.length === 1 ? "y" : "ies"}
                </strong>
                : {newCategories.slice(0, 6).join(", ")}
                {newCategories.length > 6 && ` +${newCategories.length - 6} more`}. Check the
                spelling now — a typo here becomes a real category.
              </p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
