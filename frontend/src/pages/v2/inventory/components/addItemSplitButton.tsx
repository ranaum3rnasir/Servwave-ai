import { useRef } from 'react';
import { ChevronDown, FolderPlus, FolderTree, PackagePlus } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui-kit/components/ui/dropdownMenu';

/**
 * The Items screen's primary action. The main part adds an item exactly as the
 * plain "Add Item" button did; the caret opens a menu that also reaches the
 * screen's existing category surfaces, so creating a category sits beside
 * creating an item instead of hiding in the category filter.
 *
 * Composed from the kit Button and DropdownMenu: the kit has no split-button
 * primitive, and Radix's menu owns the keyboard model (Enter/Space/ArrowDown
 * open it, arrows move, Escape closes and returns focus to the caret).
 *
 * `onManageCategories` is optional: without it (no update/delete PriceBook) the
 * entry is not rendered. The page only mounts this for create PriceBook, which
 * is what both the item and the category create routes enforce.
 */
export function AddItemSplitButton({
  onAddItem,
  onAddCategory,
  onManageCategories,
}: {
  onAddItem: () => void;
  onAddCategory: () => void;
  onManageCategories?: () => void;
}) {
  // "Manage categories" opens a NON-modal panel elsewhere on the page, so it
  // must not open until this menu is gone. While the menu is still mounted
  // (closing, animating out) it can take focus back - handing it to the caret,
  // or, when the panel's scroll-into-view slides the menu out from under the
  // pointer, focusing its own content on pointerleave - and the panel reads
  // either as focus outside and closes. So the choice is parked here and run
  // from onCloseAutoFocus, which Radix fires as the content unmounts (after
  // the exit animation), one frame later, with the focus return suppressed so
  // the panel's search box keeps it.
  const afterClose = useRef<(() => void) | null>(null);
  return (
    <div className="inline-flex" role="group" aria-label="Add Item">
      <Button size="sm" className="flex-1 rounded-r-none" onClick={onAddItem}>
        <PackagePlus />
        Add Item
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            aria-label="More add options"
            className="border-primary-foreground/25 rounded-l-none border-l px-2"
          >
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(e) => {
            const run = afterClose.current;
            afterClose.current = null;
            if (!run) return;
            e.preventDefault();
            requestAnimationFrame(run);
          }}
        >
          <DropdownMenuItem onSelect={onAddItem}>
            <PackagePlus /> Add item
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddCategory}>
            <FolderPlus /> Add category
          </DropdownMenuItem>
          {onManageCategories && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  afterClose.current = onManageCategories;
                }}
              >
                <FolderTree /> Manage categories
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
