import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import SignatureCanvas from 'react-signature-canvas';

import { Button } from '@/ui-kit/components/ui/button';
import {
  effectivePixelRatio,
  sizeSignaturePad,
  type PadBox,
  type SignatureSizing,
  type SignatureStrokes,
  type StoredSignature,
} from '@/lib/signature-sizing';

/** What the public estimate page asks of the pad when the customer approves. */
export interface SignaturePadHandle {
  isEmpty: () => boolean;
  toDataURL: () => string | undefined;
}

interface SignaturePadProps {
  ref?: Ref<SignaturePadHandle>;
  /** True once a stroke is finished, false after Clear. A resize or rotation never changes it. */
  onSignedChange: (signed: boolean) => void;
}

type Layout = SignatureSizing & { box: PadBox };

const copyStrokes = (strokes: SignatureStrokes): SignatureStrokes => strokes.map((g) => g.map((p) => ({ ...p })));

/**
 * The customer's signature pad on the public estimate page (mobile slice 05, PRD module 10).
 *
 * The sizing decisions live in `lib/signature-sizing.ts`; this component only measures the box
 * and applies them. It is mounted only while the estimate can be signed, so its container exists
 * when it starts observing (the page-level observer it replaces ran during the loading spinner,
 * observed nothing, and left the buffer at 600x128 on every phone: audit F20).
 *
 * - The pad spans the card edge to edge and is 160 px tall.
 * - On every size change the buffer is re-sized to box x pixel ratio, the context is scaled to
 *   match, and the strokes drawn so far are redrawn (resizing a canvas wipes it).
 * - Touch on the canvas never pans the page (`touch-none`; the library also sets it inline).
 */
export function SignaturePad({ ref, onSignedChange }: SignaturePadProps) {
  const sigRef = useRef<SignatureCanvas>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  /** The source of truth for a redraw: the strokes and the box they were recorded in. */
  const storedRef = useRef<StoredSignature | null>(null);

  const measure = useCallback((box: PadBox) => {
    const current = layoutRef.current;
    if (current && current.box.width === box.width && current.box.height === box.height && current.scale === effectivePixelRatio(window.devicePixelRatio)) {
      return;
    }
    const sizing = sizeSignaturePad({ box, pixelRatio: window.devicePixelRatio, stored: storedRef.current });
    if (!sizing) return;
    const next = { ...sizing, box };
    layoutRef.current = next;
    setLayout(next);
  }, []);

  // First size before paint, then follow every change of the box (rotation, resize, zoom).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    measure({ width: rect.width, height: rect.height });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) measure({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // The new width/height attributes are on the canvas by now, which wiped it and reset its
  // transform: scale the context to the buffer, then put the strokes back.
  useLayoutEffect(() => {
    const sig = sigRef.current;
    if (!layout || !sig) return;
    sig.getCanvas().getContext('2d')?.setTransform(layout.scale, 0, 0, layout.scale, 0, 0);
    // The library's typings call the point groups Point instances; at runtime they are plain {x, y, time, color}.
    if (layout.strokes.length > 0) sig.fromData(layout.strokes as unknown as Parameters<SignatureCanvas['fromData']>[0]);
    else sig.clear();
  }, [layout]);

  const handleEnd = () => {
    const sig = sigRef.current;
    const current = layoutRef.current;
    // Keep what was drawn, with the box it was drawn in, for the next resize to redraw.
    if (sig && current) storedRef.current = { strokes: copyStrokes(sig.toData() as unknown as SignatureStrokes), box: current.box };
    onSignedChange(true);
  };

  const handleClear = () => {
    sigRef.current?.clear();
    storedRef.current = null;
    onSignedChange(false);
  };

  useImperativeHandle(ref, () => ({
    // No pad instance (only possible mid-unmount) is not proof of a blank pad; the server
    // refuses an approval without signature data either way.
    isEmpty: () => sigRef.current?.isEmpty() ?? false,
    toDataURL: () => sigRef.current?.toDataURL('image/png'),
  }));

  return (
    <>
      <div className="bg-kit-card -mx-4 mt-2 overscroll-contain border-y">
        <div ref={boxRef} className="h-40 w-full">
          <SignatureCanvas
            ref={sigRef}
            clearOnResize={false}
            backgroundColor="white"
            onEnd={handleEnd}
            canvasProps={{
              // Both set, so the library never sizes the canvas itself; until the first
              // measurement the buffer is a placeholder that the layout effect replaces before paint.
              width: layout?.buffer.width ?? 1,
              height: layout?.buffer.height ?? 1,
              role: 'img',
              'aria-label': 'Signature pad. Draw your signature here with your finger or mouse.',
              className: 'block size-full touch-none select-none',
            }}
          />
        </div>
      </div>
      <Button type="button" variant="ghost" className="mt-1 h-11 min-w-11 px-3" onClick={handleClear}>
        Clear
      </Button>
    </>
  );
}
