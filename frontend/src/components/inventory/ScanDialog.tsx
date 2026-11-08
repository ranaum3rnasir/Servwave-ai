import type React from "react";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Camera,
  Eye,
  PackagePlus,
  QrCode,
  ScanLine,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/patterns/FormField";
import { formatCurrency } from "@/lib/utils";
import { useInventoryItems } from "@/lib/api/inventory";
import type { Item } from "@/lib/api/inventory";
import { useAppAbility } from "@/contexts/AbilityContext";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  onMatch: (item: Item) => void;
  onRestock?: (item: Item) => void;
  onCreateNew?: (scannedCode: string) => void;
  /**
   * When true, the dialog is in "picker" mode — used by other dialogs that just
   * need to resolve a scan to an item and return it. Hides the multi-action
   * panel and shows a single "Use this item" CTA after a match.
   */
  pickerMode?: boolean;
};

type Phase = "ready" | "scanning" | "matched" | "no_match";

export function ScanDialog({
  open,
  onClose,
  onMatch,
  onRestock,
  onCreateNew,
  pickerMode,
}: Props) {
  const { data: items = [] } = useInventoryItems();
  const ability = useAppAbility();
  const [phase, setPhase] = useState<Phase>("ready");
  const [scannedCode, setScannedCode] = useState("");
  const [match, setMatch] = useState<Item | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  // Track-1 coarse gate: "add stock directly" maps to manage Inventory (admin /
  // logistics); everyone else (field techs) must request approval. Fine-grained
  // actions land in Track-2 CASL.
  const canAddStock = ability.can("manage", "Inventory");

  useEffect(() => {
    if (!open) {
      setPhase("ready");
      setScannedCode("");
      setMatch(null);
    }
  }, [open]);

  function startScan() {
    setPhase("scanning");
    setMatch(null);
    setScannedCode("");
    // Simulate barcode discovery
    setTimeout(() => {
      const candidates = items.filter((i) => i.upc || i.mpn);
      const pool = candidates.length > 0 ? candidates : items;
      if (pool.length === 0) {
        setPhase("ready");
        return;
      }
      const pick = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
      const code = pick.upc || pick.mpn || pick.sku;
      setScannedCode(code);
      setMatch(pick);
      setPhase("matched");
    }, 1600);
  }

  function manualLookup(value: string) {
    setScannedCode(value);
    if (!value.trim()) {
      setMatch(null);
      setPhase("ready");
      return;
    }
    const v = value.trim().toLowerCase();
    const found = items.find(
      (i) =>
        i.sku.toLowerCase() === v ||
        i.upc?.toLowerCase() === v ||
        i.mpn?.toLowerCase() === v,
    );
    if (found) {
      setMatch(found);
      setPhase("matched");
    } else {
      setMatch(null);
      setPhase("no_match");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Scan QR / Barcode"
      subtitle="Native VisionKit (iOS) / ML Kit (Android) · Bluetooth scanner supported"
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Close
          </Button>
          {match && phase === "matched" && (
            <Button size="sm"
              onClick={() => {
                onMatch(match);
                onClose();
              }}
            >
              Open Item
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Scanner viewfinder */}
        <div className="relative h-56 overflow-hidden rounded-lg bg-background-dark">
          <div
            className="absolute inset-0 opacity-25"
            style={{
              backgroundImage:
                "repeating-linear-gradient(0deg, transparent 0 4px, rgb(var(--text-on-fill) / 0.05) 4px 5px)",
            }}
          />
          {/* corner brackets */}
          <div className="pointer-events-none absolute inset-8">
            <div className="absolute left-0 top-0 h-6 w-6 border-l-2 border-t-2 border-primary-light" />
            <div className="absolute right-0 top-0 h-6 w-6 border-r-2 border-t-2 border-primary-light" />
            <div className="absolute bottom-0 left-0 h-6 w-6 border-b-2 border-l-2 border-primary-light" />
            <div className="absolute bottom-0 right-0 h-6 w-6 border-b-2 border-r-2 border-primary-light" />
            {phase === "scanning" && (
              <div className="absolute left-0 right-0 top-1/2 h-0.5 animate-pulse bg-primary-light shadow-[0_0_8px_2px_rgb(var(--ai-500)/0.8)]" />
            )}
          </div>

          <div className="absolute inset-0 flex items-center justify-center text-center">
            {phase === "ready" && (
              <div className="text-on-fill/70">
                <QrCode className="mx-auto mb-2 h-10 w-10 text-on-fill/50" />
                <p className="text-sm">Align barcode within the viewfinder</p>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <Button size="sm"
                    onClick={startScan}
                  >
                    <ScanLine className="h-3.5 w-3.5" />
                    Start Scanning
                  </Button>
                  {/* Deferred: bordered on-dark control — onDark is a ghost-only
                      context (no idle border/bg), so an "outline on dark" cell
                      that reproduces this idle border+tint doesn't exist. */}
                  <button
                    onClick={() => cameraRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-md border border-on-fill/20 bg-on-fill/5 px-3 py-1.5 text-xs font-semibold text-on-fill hover:bg-on-fill/10"
                    title="Use phone camera"
                  >
                    <Camera className="h-3.5 w-3.5" />
                    Phone Camera
                  </button>
                  <Input
                    ref={cameraRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="sr-only"
                    onChange={() => {
                      // After photo capture, simulate barcode detection
                      // (in production, run BarcodeDetector / Scandit / ML Kit on the image)
                      startScan();
                    }}
                  />
                </div>
              </div>
            )}
            {phase === "scanning" && (
              <div className="text-primary-light">
                <p className="text-sm font-medium">Scanning…</p>
                <p className="text-xs text-on-fill/50">Reading 1D / 2D codes</p>
              </div>
            )}
            {phase === "matched" && match && (
              <div className="rounded-md bg-success/10 px-4 py-2 ring-1 ring-success/20">
                <p className="text-xs font-medium uppercase tracking-wide text-on-fill">
                  Match found
                </p>
                <p className="mt-0.5 font-mono text-sm text-on-fill">
                  {scannedCode}
                </p>
              </div>
            )}
            {phase === "no_match" && (
              <div className="rounded-md bg-danger/10 px-4 py-2 ring-1 ring-danger/20">
                <p className="text-xs font-medium uppercase tracking-wide text-on-fill">
                  No match in catalog
                </p>
                <p className="mt-0.5 font-mono text-xs text-on-fill">
                  {scannedCode}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Manual entry */}
        <div>
          <FormField label="Manual / Bluetooth Wedge Entry" gap={1}>
            <Input
              value={scannedCode}
              onChange={(e) => manualLookup(e.target.value)}
              placeholder="SKU · UPC · MPN — or wedge-scan here"
              className="w-full px-3 py-2"
              autoFocus
            />
          </FormField>
        </div>

        {match && phase === "matched" && (
          <div className="rounded-md border border-success/20 bg-success/10 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-success">
                Item matched
              </span>
              <code className="font-mono text-[11px] text-success">
                {match.sku}
              </code>
            </div>
            <p className="mt-1 text-sm font-semibold text-text-primary">
              {match.name}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-text-secondary">
              <div>
                <span className="block text-[10px] uppercase text-text-secondary">
                  Category
                </span>
                {match.category}
              </div>
              <div>
                <span className="block text-[10px] uppercase text-text-secondary">
                  Vendor
                </span>
                {match.vendor}
              </div>
              <div>
                <span className="block text-[10px] uppercase text-text-secondary">
                  Unit Cost
                </span>
                <span className="font-mono">{match.unitCost != null ? formatCurrency(match.unitCost) : "\u2014"}</span>
              </div>
            </div>

            {/* Post-match action panel — role-aware OR picker-mode single CTA */}
            {pickerMode ? (
              <div className="mt-3 border-t border-success/20 pt-3">
                {/* No size prop: base h-10/text-sm replaces the raw's ~32px/
                    text-xs - disclosed, not restored (frozen SOFT ratchet).
                    A full-width primary confirm CTA reads fine at the
                    primitive's default size. */}
                <Button className="w-full"
                  onClick={() => {
                    onMatch(match);
                    onClose();
                  }}
                >
                  ✓ Use this item · {match.sku}
                </Button>
              </div>
            ) : (
              <div className="mt-3 border-t border-success/20 pt-3">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                  What do you want to do?
                </p>
                <div className="grid grid-cols-1 gap-1.5">
                  <ActionButton
                    icon={Eye}
                    label="Open item details"
                    description="See per-location stock, serials, movements"
                    onClick={() => {
                      onMatch(match);
                      onClose();
                    }}
                  />
                  {canAddStock && onRestock && (
                    <ActionButton
                      icon={PackagePlus}
                      label="Add stock (Restock)"
                      description="Logistics / admin · receives inventory directly"
                      tint="emerald"
                      onClick={() => onRestock(match)}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "no_match" && (
          <div className="rounded-md border border-danger/20 bg-danger/10 p-3">
            <p className="text-xs text-danger">
              No catalog match for{" "}
              <code className="font-mono">{scannedCode}</code>. This code isn't
              tied to any item in your price book yet.
            </p>
            {onCreateNew && (
              <Button size="sm" className="mt-2 w-full"
                onClick={() => onCreateNew(scannedCode)}
              >
                ✨ Create new item from this scan
              </Button>
            )}
            {/* The second half used to promise "AI auto-categorize runs on
                save". Nothing does that - no create path, client or server,
                categorises anything - and it was the third instance of the same
                dead claim on this feature, after the import dialog's toggle and
                its subtitle. This surface is currently unrouted (ApprovalsView
                is parked), so no customer ever read it; removed so it cannot
                come back with the surface. */}
            <p className="mt-1.5 text-[10px] text-danger">
              Opens the Add Item dialog with{" "}
              <code className="font-mono">{scannedCode}</code> pre-filled.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ActionButton({
  icon: Icon,
  label,
  description,
  onClick,
  tint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  onClick: () => void;
  tint?: "emerald" | "amber" | "muted";
}) {
  const tintCls =
    tint === "emerald"
      ? "border-success/20 bg-surface-light hover:bg-success/10"
      : tint === "amber"
        ? "border-warning/20 bg-surface-light hover:bg-warning/10"
        : tint === "muted"
          ? "border-border bg-surface-light hover:bg-background-light"
          : "border-primary/30 bg-surface-light hover:bg-primary-subtle";
  const iconCls =
    tint === "emerald"
      ? "text-success"
      : tint === "amber"
        ? "text-warning"
        : tint === "muted"
          ? "text-text-secondary"
          : "text-primary";
  return (
    // Deferred: selectable action-card row (icon + label + description) —
    // not a simple CTA, closer to a list-row shape.
    <button
      onClick={onClick}
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition ${tintCls}`}
    >
      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${iconCls}`} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-text-primary">{label}</p>
        <p className="text-[10px] text-text-secondary">{description}</p>
      </div>
    </button>
  );
}
