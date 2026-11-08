import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { VendorCard } from "../VendorCard";
import type { Vendor } from "@/lib/api/inventory";
import type { VendorSpend } from "@/lib/inventory/vendor-spend";

// The three retired fields are deliberately still ON the fixture: the API no
// longer emits them (S1.2), but a stale cache or an older client could, and
// the card must not render them either way.
const vendor = {
  id: "v1",
  name: "ADI",
  category: "Security",
  paymentTerms: "Net 30",
  leadTimeDays: 3,
  transmitMethod: "portal",
  status: "active",
} as unknown as Vendor;
const spend = {
  ytd: 1200,
  ytdPoCount: 4,
  lastOrderedAt: null,
} as unknown as VendorSpend;

function renderCard() {
  return render(
    <VendorCard
      vendor={vendor}
      spend={spend}
      shareOfYTD={0.4}
      topShareOfYTD={1}
      onClick={() => {}}
    />,
  );
}

describe("VendorCard re-skin (token guard)", () => {
  it("renders the vendor name + Active badge and uses NO raw emerald/rounded-lg classes", () => {
    const { container } = renderCard();
    expect(container.textContent).toContain("ADI");
    expect(container.textContent).toContain("Active");
    const html = container.innerHTML;
    expect(html).not.toMatch(/emerald-\d+/);
    expect(html).not.toMatch(/\brounded-lg\b/);
  });
});

describe("VendorCard - retired sending fields (S1.2)", () => {
  it("shows the account number but no payment terms, lead time or 'PO via' chip", () => {
    const { container } = renderCard();
    const text = container.textContent ?? "";
    expect(text).toContain("Account #");
    expect(text).not.toMatch(/PO via/i);
    expect(text).not.toMatch(/\bTerms\b/);
    expect(text).not.toContain("Net 30");
    expect(text).not.toMatch(/3d lead/);
    expect(text).not.toMatch(/portal/i);
  });
});
