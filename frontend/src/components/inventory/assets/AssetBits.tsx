/**
 * Tiny shared presentational bits for the Assets slice (P4) - kept in their
 * own module so the list view and the detail pane don't import each other.
 *
 * Those two were `AssetsView.tsx` and `AssetHistoryDrawer.tsx` in this
 * directory when the split was made. Both are now deleted - they hung off the
 * dead v1 `pages/inventory/InventoryPage.tsx` - and the pair this module keeps
 * apart is their routed replacement, `pages/v2/inventory/components/
 * {assetsView,assetHistoryPanel}.tsx`, which import it today. The reason for
 * the split is unchanged; only the two files on either side of it are.
 */
import { ImageIcon } from "lucide-react";
import { UploadedImage } from "@/components/ui/uploaded-image";
import type { Asset } from "@/lib/api/inventory";

export function AssetThumb({ asset, size }: { asset: Asset; size: number }) {
  if (asset.photo_url) {
    return (
      <UploadedImage
        src={asset.photo_url}
        alt={asset.name}
        radius="md"
        edge="ring"
        className="flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex flex-shrink-0 items-center justify-center rounded-md bg-background-light ring-1 ring-border"
      style={{ width: size, height: size }}
      title="No photo yet"
    >
      <ImageIcon
        className="text-text-secondary"
        style={{ width: size * 0.45, height: size * 0.45 }}
      />
    </div>
  );
}
