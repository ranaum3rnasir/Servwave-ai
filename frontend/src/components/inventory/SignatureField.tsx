import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, PenLine, RotateCcw, Sparkles, User, X } from "lucide-react";
import { FormField } from "@/components/patterns/FormField";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  clearSignature,
  fmtSignedAt,
  getSavedSignature,
  saveSignature,
  type SavedSignature,
  type SignatureValue,
} from "@/lib/inventory/signatures";
import { useAuthStore } from "@/stores/auth.store";
import { useScheduleTimezone } from '@/lib/schedule-tz';

type Props = {
  /**
   * Stable identity of the **assigned / expected** signer (ALPHA user id,
   * tech id, or vendor handle). Used to look up the signer's adopted ("saved")
   * signature in localStorage. If omitted, the signer is anonymous and cannot
   * adopt for re-use.
   */
  signerId?: string;

  /** Pre-fill the typed-name input with this name. */
  defaultName?: string;

  /** Short uppercase label above the signature box, e.g. "Tech Pickup Sign-out". */
  role: string;

  /** Caption shown when signed (under the script signature). Defaults to defaultName. */
  signerLabel?: string;

  /** Controlled signature value. Null/undefined = unsigned. */
  value?: SignatureValue | null;

  /** Fired when the signer applies a signature (typed or auto-applied). */
  onSign: (sig: SignatureValue) => void;

  /** Fired when the signer clears the signature on this doc. */
  onClear?: () => void;

  /**
   * When true, no signing UI is shown — used in print/PDF mode after the doc
   * has been signed (we still render the signature itself, just hide chrome).
   */
  readOnly?: boolean;

  /**
   * Hide the "Adopt this signature for future documents" checkbox even when
   * the signer is identifiable. Useful for one-off vendor sign blocks.
   */
  disableAdopt?: boolean;

  /**
   * The **currently logged-in user**. When provided, the field becomes
   * identity-aware: if `currentUser.id !== signerId` (the expected signer is
   * someone else), a small "Signing as:" toggle appears so the user can choose
   * to sign on behalf of the assigned person OR sign as themselves. When the
   * current user IS the assigned signer, the toggle is hidden (it's obviously
   * you) and the field auto-uses the user's adopted signature.
   *
   * Omit it to fall back to the logged-in ALPHA user from the auth store.
   */
  currentUser?: { id: string; name: string };
};

/**
 * SignatureField — DocuSign-style typed signature with one-tap re-use.
 *
 * UX states:
 *   1. SIGNED:        Renders the script-font signature, signer name, and timestamp.
 *                     A small "Re-sign" pill in the corner clears the signature.
 *   2. SAVED sig:     Shows "Apply my signature" (primary) + "Sign differently" link.
 *                     One tap applies the adopted signature with method=auto_applied.
 *   3. NO saved sig:  Inline editor — full-name input + live cursive preview +
 *                     "Adopt this signature" checkbox + "Sign" button.
 *
 * The component never persists anything to the doc itself — the parent owns
 * the SignatureValue and decides where it ultimately lives (PO, pickup ticket,
 * approval record, etc.).
 */
export function SignatureField({
  signerId,
  defaultName = "",
  role,
  signerLabel,
  value,
  onSign,
  onClear,
  readOnly,
  disableAdopt,
  currentUser: currentUserProp,
}: Props) {
  // ---- Current user (auth store fallback) --------------------------------
  // The slice wires the signing identity to the logged-in ALPHA user: when the
  // parent dialog does not pass an explicit `currentUser`, derive it from the
  // auth store so signatures + the "You" audit chip stay attributable.
  const authUser = useAuthStore((s) => s.user);
  const tz = useScheduleTimezone();
  const currentUser = useMemo<{ id: string; name: string } | undefined>(() => {
    if (currentUserProp) return currentUserProp;
    if (!authUser) return undefined;
    const name = `${authUser.first_name} ${authUser.last_name}`.trim();
    return { id: authUser.id, name };
  }, [currentUserProp, authUser]);

  // ---- Identity model ----------------------------------------------------
  // The "expected" identity is the assigned signer (signerId + defaultName).
  // The "self" identity is the currently logged-in user (currentUser).
  // If the two match (current user IS the assigned signer), no toggle is
  // needed — the field is auto-personalized. If they differ, the user can
  // toggle which identity to sign with:
  //   - "Sign as <expected>" — typing on behalf (counter-pickup scenario)
  //   - "Sign as <you>"      — signing as themselves
  // Defaults to "self" when the current user is recognized as the assigned
  // signer; otherwise defaults to "expected" (preserves doc intent).
  const expectedSignerId = signerId;
  const expectedSignerName = defaultName;
  const expectedSignerLabel = signerLabel ?? defaultName;

  const isCurrentUserExpected =
    !!currentUser && !!expectedSignerId && currentUser.id === expectedSignerId;
  const showIdentityToggle =
    !!currentUser &&
    !!expectedSignerName &&
    !isCurrentUserExpected &&
    currentUser.name !== expectedSignerName;

  const [activeIdentity, setActiveIdentity] = useState<"expected" | "self">(
    isCurrentUserExpected ? "self" : "expected",
  );

  // Reset the active identity when the underlying expected signer changes
  // (e.g. user opens a different stage / approval).
  useEffect(() => {
    setActiveIdentity(isCurrentUserExpected ? "self" : "expected");
  }, [expectedSignerId, currentUser?.id, isCurrentUserExpected]);

  // Resolve the effective identity actually doing the signing.
  const effectiveSignerId =
    activeIdentity === "self" && currentUser ? currentUser.id : expectedSignerId;
  const effectiveDefaultName =
    activeIdentity === "self" && currentUser
      ? currentUser.name
      : expectedSignerName;
  const effectiveSignerLabel =
    activeIdentity === "self" && currentUser
      ? `${currentUser.name} (you)`
      : expectedSignerLabel;

  // ---- Storage + form state ---------------------------------------------
  const [saved, setSaved] = useState<SavedSignature | null>(() =>
    effectiveSignerId ? getSavedSignature(effectiveSignerId) : null,
  );
  const [editing, setEditing] = useState(false);
  const [typedName, setTypedName] = useState(effectiveDefaultName);
  const [adopt, setAdopt] = useState(true);

  // Re-read saved signature + reset typed-name when the active identity changes.
  useEffect(() => {
    setSaved(effectiveSignerId ? getSavedSignature(effectiveSignerId) : null);
    setTypedName(effectiveDefaultName);
    setEditing(false);
  }, [effectiveSignerId, effectiveDefaultName]);

  const canAdopt = !!effectiveSignerId && !disableAdopt;
  const hasSaved = !!saved && !!effectiveSignerId;

  // === SIGNED state ===
  if (value && value.fullName) {
    return (
      <div className="relative">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
          {role}
        </div>

        {/* The script-rendered signature */}
        <div
          className="sig-script mt-1 select-none text-2xl leading-tight text-primary"
          title={`Signed ${fmtSignedAt(value.signedAt, tz)}`}
        >
          {value.fullName}
        </div>

        <div className="mt-0.5 border-b border-border" />

        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-text-secondary">
          <span className="font-medium text-text-primary">
            {effectiveSignerLabel || value.fullName}
          </span>
          <span aria-hidden>·</span>
          <span>{fmtSignedAt(value.signedAt, tz)}</span>
          {value.method === "auto_applied" && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-primary-subtle px-1 py-px text-[9px] font-medium text-primary"
              title="Applied with adopted signature"
            >
              <Sparkles className="h-2.5 w-2.5" />
              Auto-applied
            </span>
          )}
          {currentUser && value.signerId === currentUser.id && (
            <span
              className="inline-flex items-center gap-0.5 rounded bg-success/10 px-1 py-px text-[9px] font-medium text-success"
              title="Signed by the current user"
            >
              <User className="h-2.5 w-2.5" />
              You
            </span>
          )}
        </div>

        {!readOnly && onClear && (
          // outline/neutral matches border/bg/hover exactly; dropped on
          // conversion: shadow-sm (HARD, banned in className), the
          // rounded-full pill shape (Button's own rounded-button radius
          // wins), and the explicit idle text-secondary (inherits ambient —
          // this wrapper sets no text colour, matching the primitive's other
          // 202 outline/neutral call sites). Base text-sm font-semibold also
          // replaces the raw's text-[9px] font-medium - disclosed, not
          // restored (frozen SOFT ratchet, same as "Sign differently" below).
          <Button variant="outline" tone="neutral" size={null}
            type="button"
            onClick={() => {
              onClear();
              setEditing(false);
            }}
            className="absolute -right-1 -top-1 gap-0.5 px-1.5 py-0.5"
            title="Clear signature and re-sign"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            Re-sign
          </Button>
        )}
      </div>
    );
  }

  // === UNSIGNED — read-only (print preview before signing) ===
  if (readOnly) {
    return (
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
          {role}
        </div>
        <div className="mt-6 border-b border-border" />
        <div className="mt-1 text-[10px] italic text-text-secondary">
          {effectiveSignerLabel || effectiveDefaultName || "Awaiting signature"} · Unsigned
        </div>
      </div>
    );
  }

  // === UNSIGNED state ===
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
          {role}
        </div>
        <span className="text-[9px] italic text-text-secondary">Required</span>
      </div>

      {/* Identity-aware "Signing as" toggle — only shows when the logged-in
          user is NOT the assigned signer for this block. Picking "you"
          swaps the underlying signer identity so the right adopted signature
          is offered and the audit captures the actual signer. */}
      {showIdentityToggle && (
        <div className="mt-1 flex flex-wrap items-center gap-1 rounded-md border border-border bg-background-light px-2 py-1 text-[10px]">
          <span className="font-semibold uppercase tracking-wide text-text-secondary">
            Signing as
          </span>
          {/* Deferred: two-option identity segmented toggle — not Button-shaped. */}
          <button
            type="button"
            onClick={() => setActiveIdentity("expected")}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
              activeIdentity === "expected"
                ? "bg-primary text-on-fill shadow-sm"
                : "bg-surface-light text-text-secondary ring-1 ring-border hover:bg-background-light"
            }`}
            title={`Sign on behalf of ${expectedSignerName}`}
          >
            {expectedSignerName}
          </button>
          <button
            type="button"
            onClick={() => setActiveIdentity("self")}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition ${
              activeIdentity === "self"
                ? "bg-primary text-on-fill shadow-sm"
                : "bg-surface-light text-text-secondary ring-1 ring-border hover:bg-background-light"
            }`}
            title="Sign as yourself"
          >
            <User className="h-2.5 w-2.5" />
            {currentUser!.name} (you)
          </button>
        </div>
      )}

      {/* Auto-personalized banner — when the logged-in user IS the assigned
          signer, confirm it visually so they know the field is theirs. */}
      {isCurrentUserExpected && currentUser && (
        <div className="mt-1 flex items-center gap-1.5 rounded-md border border-success/20 bg-success/10 px-2 py-1 text-[10px] text-success">
          <User className="h-3 w-3" />
          <span>
            This block is yours — auto-personalized for{" "}
            <strong>{currentUser.name}</strong>.
          </span>
        </div>
      )}

      {/* Saved-signature one-tap branch */}
      {hasSaved && !editing && (
        <div className="mt-1 rounded-md border border-primary/30 bg-primary-subtle p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-wide text-primary">
                Your adopted signature
              </div>
              <div className="sig-script mt-0.5 truncate text-xl leading-tight text-primary">
                {saved!.fullName}
              </div>
            </div>
            <Button size="3xs"
              type="button"
              onClick={() => {
                onSign({
                  fullName: saved!.fullName,
                  signedAt: new Date().toISOString(),
                  method: "auto_applied",
                  signerId: effectiveSignerId,
                });
              }}
              className="shrink-0 gap-1"
            >
              <CheckCircle2 className="h-3 w-3" />
              Apply my signature
            </Button>
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-primary/80">
            <span>Adopted {fmtSignedAt(saved!.adoptedAt, tz)}</span>
            <div className="flex items-center gap-2">
              {/* link/brand's idle text-primary is close to the raw's
                  inherited text-primary/80 (this row's ambient colour);
                  base text-sm font-semibold replaces the raw's inherited
                  10px/medium — disclosed, not restored (frozen SOFT ratchet). */}
              <Button variant="link" tone="brand" size={null}
                type="button"
                onClick={() => {
                  setTypedName(effectiveDefaultName || saved!.fullName);
                  setEditing(true);
                }}
              >
                Sign differently
              </Button>
              {/* Deferred: small icon-only "forget" close-X affordance. */}
              <button
                type="button"
                onClick={() => {
                  if (!effectiveSignerId) return;
                  clearSignature(effectiveSignerId);
                  setSaved(null);
                }}
                title="Forget adopted signature"
                className="hover:underline"
              >
                <X className="inline h-2.5 w-2.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Type-to-sign branch */}
      {(!hasSaved || editing) && (
        <div className="mt-1 rounded-md border border-dashed border-border bg-background-light p-2">
          {/* gap={0}: the Input keeps its own `mt-1` seam (a parallel batch
              owns input/textarea conversions in this file), so the wrapper
              contributes no second gap on top of it. */}
          <FormField label="Type your full name to sign" gap={0}>
            <Input
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              placeholder={effectiveDefaultName || "Full legal name"}
              className="mt-1 w-full px-2 py-1"
              autoComplete="off"
            />
          </FormField>

          {/* Live cursive preview */}
          <div className="mt-2 flex min-h-[3rem] items-center justify-center rounded border border-border bg-surface-light">
            {typedName.trim() ? (
              <div className="sig-script select-none px-3 py-1 text-3xl leading-none text-primary">
                {typedName.trim()}
              </div>
            ) : (
              <span className="py-2 text-[10px] italic text-text-secondary">
                Your signature will appear here
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            {canAdopt ? (
              <label className="flex items-center gap-1.5 text-[10px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={adopt}
                  onChange={(e) => setAdopt(e.target.checked)}
                  className="h-3 w-3 rounded border-border text-primary focus:ring-primary"
                />
                Adopt for future documents
              </label>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              {/* Deferred: text-secondary hover:underline link — no link+
                  neutral tone is minted (link only has brand). */}
              {hasSaved && editing && (
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="text-[10px] text-text-secondary hover:underline"
                >
                  Cancel
                </button>
              )}
              <Button size="3xs"
                type="button"
                disabled={!typedName.trim()}
                onClick={() => {
                  const name = typedName.trim();
                  if (!name) return;
                  if (canAdopt && adopt) {
                    setSaved(saveSignature(effectiveSignerId!, name));
                  }
                  onSign({
                    fullName: name,
                    signedAt: new Date().toISOString(),
                    method: "typed",
                    signerId: effectiveSignerId,
                  });
                  setEditing(false);
                }}
                className="gap-1"
              >
                <PenLine className="h-3 w-3" />
                {canAdopt && adopt ? "Adopt & Sign" : "Sign"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact signed-doc badge — used in approval/PO list views to show that
 * a doc has been countersigned without re-rendering the full SignatureField.
 */
export function SignedBadge({ value }: { value: SignatureValue }) {
  const tz = useScheduleTimezone();
  return useMemo(
    () => (
      <span
        className="inline-flex items-center gap-1 rounded-full border border-success/20 bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
        title={`Signed by ${value.fullName} · ${fmtSignedAt(value.signedAt, tz)}`}
      >
        <CheckCircle2 className="h-2.5 w-2.5" />
        Signed
        <span className="sig-script text-[13px] leading-none">
          {value.fullName.split(" ")[0]}
        </span>
      </span>
    ),
    [value],
  );
}
