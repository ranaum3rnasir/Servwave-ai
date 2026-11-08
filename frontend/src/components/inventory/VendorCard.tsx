import {
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  ShoppingCart,
  User,
} from "lucide-react";
import type { Vendor } from "@/lib/api/inventory";
import { safeHref } from "@/lib/safe-href";
import { vendorCategoryLabel } from "@/lib/inventory/vendor-category";
import { formatPhone } from "@/lib/utils";
import {
  fmtMoney,
  fmtRelativeDate,
  type VendorSpend,
} from "@/lib/inventory/vendor-spend";

type Props = {
  vendor: Vendor;
  spend: VendorSpend;
  shareOfYTD: number;        // 0..1, vendor.ytd / orgTotalYTD
  topShareOfYTD: number;     // 0..1, used to scale the bar
  onClick: () => void;
};

export function VendorCard({
  vendor,
  spend,
  shareOfYTD,
  topShareOfYTD,
  onClick,
}: Props) {
  const isInactive = vendor.status === "inactive";
  const barWidth =
    topShareOfYTD > 0
      ? Math.max(2, Math.min(100, (shareOfYTD / topShareOfYTD) * 100))
      : 0;

  return (
    // Not converted to Button: whole-card click target with heterogeneous
    // content (badges, links, stat strip), not a Button shape.
    <button
      onClick={onClick}
      className={[
        "group flex h-full flex-col gap-2 rounded-card border bg-surface-light p-4 text-left transition",
        "hover:-translate-y-0.5 hover:shadow-md hover:border-primary/40",
        isInactive ? "opacity-70" : "",
        "border-border",
      ].join(" ")}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-text-primary group-hover:text-primary">
            {vendor.name}
          </p>
          <p className="mt-0.5 text-[11px] text-text-secondary">{vendorCategoryLabel(vendor)}</p>
        </div>
        <span
          className={[
            "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ring-1",
            isInactive
              ? "bg-background-light text-text-secondary ring-border"
              : "bg-success/10 text-success ring-success/20",
          ].join(" ")}
        >
          {isInactive ? "Archived" : "Active"}
        </span>
      </div>

      {/* Contact + account */}
      <div className="mt-1 space-y-1 text-[11px] text-text-secondary">
        {vendor.contactPersonName && (
          <div className="flex items-center gap-1.5">
            <User className="h-3 w-3 flex-shrink-0 text-text-secondary" />
            <span className="truncate font-medium text-text-secondary">
              {vendor.contactPersonName}
            </span>
            {(vendor.additionalContacts?.length ?? 0) > 0 && (
              <span
                className="ml-auto inline-flex flex-shrink-0 items-center rounded-full bg-primary/10 px-1.5 py-0 text-[9px] font-bold text-primary ring-1 ring-primary/20"
                title={`${vendor.additionalContacts!.length} additional contact${vendor.additionalContacts!.length === 1 ? "" : "s"} on this vendor`}
              >
                +{vendor.additionalContacts!.length}
              </span>
            )}
          </div>
        )}
        {vendor.contactEmail && (
          <a
            href={`mailto:${vendor.contactEmail}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 hover:text-primary"
          >
            <Mail className="h-3 w-3 flex-shrink-0 text-text-secondary" />
            <span className="truncate">{vendor.contactEmail}</span>
          </a>
        )}
        {vendor.contactPhone && (
          <a
            href={`tel:${vendor.contactPhone}`}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 hover:text-primary"
          >
            <Phone className="h-3 w-3 flex-shrink-0 text-text-secondary" />
            <span>{formatPhone(vendor.contactPhone)}</span>
          </a>
        )}
        {vendor.website && (
          <a
            href={safeHref(vendor.website)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 text-primary hover:text-primary/80"
          >
            <ExternalLink className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">
              {vendor.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </span>
          </a>
        )}
      </div>

      {/* Account number */}
      <div className="mt-1 border-t border-border pt-2 text-[10px]">
        <span className="block text-[9px] uppercase text-text-secondary">
          Account #
        </span>
        <code className="font-mono text-[11px] font-semibold text-text-secondary">
          {vendor.accountNumber ?? "—"}
        </code>
      </div>

      {/* Spend strip */}
      <div className="mt-2 rounded-card border border-success/20 bg-success/10 p-2">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <span className="block text-[9px] font-semibold uppercase tracking-wide text-success">
              YTD Spend
            </span>
            <span className="text-lg font-bold text-text-primary">
              {fmtMoney(spend.ytd)}
            </span>
          </div>
          <div className="text-right text-[10px] text-text-secondary">
            <div>
              <ShoppingCart className="mr-0.5 inline h-2.5 w-2.5" />
              {spend.ytdPoCount} POs
            </div>
            <div className="text-text-secondary">
              {spend.lastOrderedAt
                ? `last ${fmtRelativeDate(spend.lastOrderedAt)}`
                : "no orders"}
            </div>
          </div>
        </div>
        {/* Share bar */}
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-success/10">
          <div
            className="h-full rounded-full bg-success transition-all"
            style={{ width: `${barWidth}%` }}
          />
        </div>
        <div className="mt-0.5 text-[9px] text-success">
          {(shareOfYTD * 100).toFixed(1)}% of total inventory spend
        </div>
      </div>

      {/* Pickup hint */}
      {vendor.pickupAddress && (
        <div className="mt-auto flex items-start gap-1.5 pt-1 text-[10px] text-text-secondary">
          <MapPin className="mt-0.5 h-2.5 w-2.5 flex-shrink-0 text-text-secondary" />
          <span className="truncate">{vendor.pickupAddress}</span>
        </div>
      )}

    </button>
  );
}
