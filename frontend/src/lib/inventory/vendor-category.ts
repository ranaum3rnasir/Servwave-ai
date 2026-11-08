import type { Vendor } from "@/lib/api/inventory";

/**
 * What a vendor with no category is called everywhere it is shown (card,
 * detail hero, picker, category tab, analytics column). The server stores the
 * absence as `categoryId: null` + `category: ''`; this is the one place the
 * word is spelled.
 */
export const UNCATEGORIZED_LABEL = "Uncategorized";

/**
 * Longest vendor category name the create and rename routes accept
 * (`vendorCategorySchema`, zod `.max(200)`). The manager's inputs stop here so
 * the raw validation message never reaches the user.
 */
export const VENDOR_CATEGORY_NAME_MAX = 200;

export function vendorCategoryLabel(vendor: Pick<Vendor, "category">): string {
  return vendor.category.trim() || UNCATEGORIZED_LABEL;
}
