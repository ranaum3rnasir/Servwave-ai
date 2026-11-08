import { Link } from "react-router-dom";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

/** Where inventory locations are managed (settings.routes.tsx → LocationsPage). */
export const INVENTORY_LOCATIONS_SETTINGS_PATH = "/settings/locations";

/**
 * NoInventoryLocationDialog (PRD-4, B12 / S4.3).
 *
 * Wherever stock has to land somewhere - receiving a PO, staging a pickup -
 * and the company has no inventory location at all, this is the one answer.
 * It replaces the two dead ends it used to be: plain "No inventory locations
 * available" text in the Receive strip with nothing to click, and a Create
 * Pickup that silently built a stage with no location. It explains what is
 * missing and links to the page that fixes it; the caller decides what to do
 * about its own state on Close (the Receive dialog stays in receive mode,
 * Create Pickup simply does not submit).
 */
export function NoInventoryLocationDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      width="sm"
      title="No inventory location yet"
      data-testid="no-inventory-location-dialog"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Close
          </Button>
          {/* asChild: the primary action IS the navigation, so it renders as
              the router link itself rather than a button that navigates. */}
          <Button size="sm" asChild>
            <Link to={INVENTORY_LOCATIONS_SETTINGS_PATH} onClick={onClose}>
              Go to Settings → Locations
            </Link>
          </Button>
        </>
      }
    >
      <p className="text-sm text-text-secondary">
        Receiving parts and staging a pickup both need an inventory location to
        put the stock into, and this company does not have one yet. Locations
        are managed under Settings → Locations — add one there (a warehouse or a
        van), then come back and try again.
      </p>
    </Modal>
  );
}
