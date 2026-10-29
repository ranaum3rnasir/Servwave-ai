import { useEffect, useRef, useState } from 'react';

import { useOrganization, useUpdateOrganization, useUploadLogo } from '@/lib/api/organization';
import { getAccessToken } from '@/lib/supabase';
import { DEFAULT_BRAND_COLOR } from '@/lib/branding';
// The app's Thumbnail, not a raw <img>: the kit ships no image primitive and
// the raw-<img> ratchet in component-api-guard sits at its floor.
import { Thumbnail } from '@/components/ui/thumbnail';

import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { Spinner } from '@/ui-kit/components/ui/spinner';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { TabStrip, TabPanel } from '../_shared/tabs';
import { useSettingsBar } from './settingsBar';
import { Section } from './components/section';

const TEMPLATES = [
  { value: 'alpha-classic', label: 'Classic' },
  { value: 'crm-default', label: 'CRM Default' },
];

// One template + brand color drives both documents - this toggle only switches which
// document the preview/copy panel shows, not a second template picker.
const PREVIEW_DOCS = [
  { value: 'estimate', label: 'Estimate' },
  { value: 'invoice', label: 'Invoice' },
] as const;
type PreviewDoc = (typeof PREVIEW_DOCS)[number]['value'];

// #114 - Brand color must be a 6-digit hex; the server enforces the same regex.
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/**
 * Shared by the Live Preview panel and the Document Copy tab - same toggle, same options,
 * different aria-label per panel.
 *
 * Built from kit Buttons rather than the app's ToggleGroup: the kit ships no
 * toggle-group primitive, and a segmented pair of `aria-pressed` buttons keeps
 * the same role="group" contract without pulling a second component family into
 * the v2 layer. The reclick-deselect guard the Radix version needed is moot here
 * - clicking the active option simply re-sets the same value.
 */
function PreviewDocToggle({
  value, onChange, ariaLabel,
}: {
  value: PreviewDoc;
  onChange: (v: PreviewDoc) => void;
  ariaLabel: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex gap-1">
      {PREVIEW_DOCS.map((d) => (
        <Button
          key={d.value}
          size="sm"
          variant={value === d.value ? 'secondary' : 'outline'}
          aria-pressed={value === d.value}
          onClick={() => onChange(d.value)}
        >
          {d.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * Settings > Branding & Templates.
 *
 * `brand_color` is DATA, not a design token: it is a user-chosen arbitrary hex
 * consumed server-side when rendering estimate/invoice PDFs and email headers.
 * It never writes a CSS variable and never touches tokens.css, so it stays an
 * inline style here. Folding an arbitrary user value into the token file is
 * impossible by construction.
 *
 * The PDF preview pipeline is carried across whole - 350ms debounce, a blob
 * cache keyed on doc|template|colour|logo_url, a cancellation flag, and
 * revokeObjectURL on unmount. Losing any part of it turns the colour picker
 * into a fetch storm.
 */
export default function BrandingPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const uploadLogo = useUploadLogo();
  const { registerSaver } = useSettingsBar();
  const fileRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState('branding');
  const [brandColor, setBrandColor] = useState(DEFAULT_BRAND_COLOR);
  const [template, setTemplate] = useState('alpha-classic');
  // Estimate document copy moved here from the Payments & Lists screen - it's the
  // text printed on the document, so it belongs with templates/branding.
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  // Invoice document copy - separate fields, no fallback to the estimate copy above.
  const [invoiceTerms, setInvoiceTerms] = useState('');
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoicePaymentTerms, setInvoicePaymentTerms] = useState('');
  // Which document the live preview (Branding tab) and the copy fields (Document Copy
  // tab) currently show - one template/brand-color setup renders both documents.
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc>('estimate');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // Cache the generated PDF per doc+template+color so re-selecting one is instant.
  const previewCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (org && !loaded) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate seed-the-form-once idiom, gated by `loaded` so a refetch never clobbers edits
      setBrandColor(org.brand_color ?? DEFAULT_BRAND_COLOR);
      setTemplate(org.estimate_template ?? 'alpha-classic');
      setTerms(org.estimate_terms ?? '');
      setNotes(org.estimate_notes ?? '');
      setPaymentTerms(org.estimate_payment_terms ?? '');
      setInvoiceTerms(org.invoice_terms ?? '');
      setInvoiceNotes(org.invoice_notes ?? '');
      setInvoicePaymentTerms(org.invoice_payment_terms ?? '');
      setLoaded(true);
    }
  }, [org, loaded]);

  const isDirty =
    !!org &&
    (brandColor !== (org.brand_color ?? DEFAULT_BRAND_COLOR) ||
      template !== (org.estimate_template ?? 'alpha-classic') ||
      terms !== (org.estimate_terms ?? '') ||
      notes !== (org.estimate_notes ?? '') ||
      paymentTerms !== (org.estimate_payment_terms ?? '') ||
      invoiceTerms !== (org.invoice_terms ?? '') ||
      invoiceNotes !== (org.invoice_notes ?? '') ||
      invoicePaymentTerms !== (org.invoice_payment_terms ?? ''));
  const hexValid = HEX_RE.test(brandColor);

  useEffect(() => {
    registerSaver({
      save: async () => {
        // Block the save (and the bar's success toast) when the hex is invalid;
        // the inline error below explains why. Tag it as a ValidationError so the
        // settings shell can surface a toast (mutation/network errors toast their
        // own detail and must not be double-toasted).
        if (!hexValid) {
          const e = new Error(`Brand color must be a 6-digit hex, e.g. ${DEFAULT_BRAND_COLOR}`);
          e.name = 'ValidationError';
          throw e;
        }
        await update.mutateAsync({
          brand_color: brandColor,
          estimate_template: template,
          estimate_terms: terms,
          estimate_notes: notes,
          estimate_payment_terms: paymentTerms,
          invoice_terms: invoiceTerms,
          invoice_notes: invoiceNotes,
          invoice_payment_terms: invoicePaymentTerms,
        });
      },
      discard: () => {
        if (org) {
          setBrandColor(org.brand_color ?? DEFAULT_BRAND_COLOR);
          setTemplate(org.estimate_template ?? 'alpha-classic');
          setTerms(org.estimate_terms ?? '');
          setNotes(org.estimate_notes ?? '');
          setPaymentTerms(org.estimate_payment_terms ?? '');
          setInvoiceTerms(org.invoice_terms ?? '');
          setInvoiceNotes(org.invoice_notes ?? '');
          setInvoicePaymentTerms(org.invoice_payment_terms ?? '');
        }
      },
      isDirty,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, brandColor, template, terms, notes, paymentTerms, invoiceTerms, invoiceNotes, invoicePaymentTerms]);

  // PDF preview (authed fetch -> blob URL). Reflects the picked color live (debounced),
  // shows a real loading state, and caches each doc+template+color so re-selecting is instant.
  useEffect(() => {
    const color = hexValid ? brandColor : org?.brand_color ?? DEFAULT_BRAND_COLOR;
    // Include logo_url in the key so a logo upload busts the cache and the iframe
    // regenerates (the server embeds the org logo in the rendered PDF).
    const key = `${previewDoc}|${template}|${color}|${org?.logo_url ?? ''}`;
    const cached = previewCache.current.get(key);
    if (cached) {
      setPreviewUrl(cached);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      const token = getAccessToken();
      const url = `${import.meta.env.VITE_API_URL || ''}/api/organization/preview-pdf?doc=${previewDoc}&template=${template}&color=${encodeURIComponent(color)}`;
      fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        .then((res) => (res.ok ? res.blob() : Promise.reject()))
        .then((blob) => {
          if (cancelled) return;
          const objectUrl = URL.createObjectURL(blob);
          previewCache.current.set(key, objectUrl);
          setPreviewUrl(objectUrl);
          setPreviewLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setPreviewUrl(null);
          setPreviewLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [previewDoc, template, brandColor, hexValid, org?.brand_color, org?.logo_url]);

  // Revoke all cached blob URLs on unmount.
  useEffect(() => {
    const cache = previewCache.current;
    return () => cache.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const onLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await uploadLogo.mutateAsync(file);
  };

  // Document Copy tab renders ONE set of fields, pointed at whichever document the
  // shared toggle currently selects - not a second copy of the JSX per document.
  const isInvoiceCopy = previewDoc === 'invoice';
  const activeTerms = isInvoiceCopy ? invoiceTerms : terms;
  const setActiveTerms = isInvoiceCopy ? setInvoiceTerms : setTerms;
  const activeNotes = isInvoiceCopy ? invoiceNotes : notes;
  const setActiveNotes = isInvoiceCopy ? setInvoiceNotes : setNotes;
  const activePaymentTerms = isInvoiceCopy ? invoicePaymentTerms : paymentTerms;
  const setActivePaymentTerms = isInvoiceCopy ? setInvoicePaymentTerms : setPaymentTerms;

  return (
    <>
      <TabStrip
        value={activeTab}
        onValueChange={setActiveTab}
        tabs={[
          { value: 'branding', label: 'Branding' },
          { value: 'documents', label: 'Document Copy' },
        ]}
      />

      <TabPanel value="branding" activeValue={activeTab}>
        <div className="grid grid-cols-1 gap-6 pt-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* LEFT - Document Templates + live preview */}
          <div className="space-y-6">
            <Section title="Document Template">
              <div role="group" aria-label="Document template" className="flex gap-3">
                {TEMPLATES.map((t) => (
                  <Button
                    key={t.value}
                    variant={template === t.value ? 'secondary' : 'outline'}
                    aria-pressed={template === t.value}
                    onClick={() => setTemplate(t.value)}
                  >
                    {t.label}
                    {template === t.value && ' ✓'}
                  </Button>
                ))}
              </div>
            </Section>

            <Section
              title={`Live Preview - ${TEMPLATES.find((t) => t.value === template)?.label}`}
              action={
                /* Switches which document the SAME template + brand color render;
                   it is not a second template picker. */
                <PreviewDocToggle value={previewDoc} onChange={setPreviewDoc} ariaLabel="Preview document" />
              }
            >
              {previewLoading ? (
                <div className="text-muted-foreground flex h-[200px] items-center justify-center gap-2 text-sm">
                  <Spinner />
                  Generating preview...
                </div>
              ) : previewUrl ? (
                <iframe
                  title="Document preview"
                  src={previewUrl}
                  className="border-border h-[700px] w-full rounded-md border"
                />
              ) : (
                <div className="text-muted-foreground flex h-[200px] items-center justify-center text-sm">
                  Preview unavailable
                </div>
              )}
            </Section>
          </div>

          {/* RIGHT - Brand Identity */}
          <div className="space-y-6">
            <Section title="Company Logo">
              <div className="flex items-center gap-4">
                <div className="border-border bg-muted flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border">
                  {org?.logo_url ? (
                    <Thumbnail src={org.logo_url} alt="Logo" className="h-full w-full object-contain" />
                  ) : (
                    <span className="text-muted-foreground text-xs">No logo</span>
                  )}
                </div>
                {/* The kit Input rather than a raw <input>: the raw-<input>
                    ratchet is at its floor, and a hidden file picker is still an
                    input. */}
                <Input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  aria-label="Upload company logo"
                  className="hidden"
                  onChange={onLogoChange}
                />
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploadLogo.isPending}>
                  {uploadLogo.isPending ? 'Uploading...' : 'Replace logo'}
                </Button>
              </div>
            </Section>

            <Section
              title="Brand Color"
              description="Used as the accent on estimate & invoice PDFs and email headers. The live preview on the left updates as you pick, so you can see the effect before saving."
            >
              <div className="flex items-center gap-3">
                {/* type="color" through the kit Input: a native swatch, not a text
                    box, but still an <input>, and the raw-tag ratchet counts it. */}
                <Input
                  type="color"
                  aria-label="Brand color swatch"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="h-10 w-14 cursor-pointer p-1"
                />
                <div className="w-32">
                  <Label htmlFor="brand-color-hex" className="text-xs">Hex</Label>
                  <Input
                    id="brand-color-hex"
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    aria-invalid={!hexValid}
                  />
                </div>
              </div>
              <div className="flex gap-1">
                {[1, 0.8, 0.6, 0.4, 0.2].map((o) => (
                  <span
                    key={o}
                    className="h-8 w-8 rounded"
                    style={{ backgroundColor: hexValid ? brandColor : undefined, opacity: o }}
                  />
                ))}
              </div>
              {!hexValid && (
                <p className="text-destructive text-xs">
                  Enter a 6-digit hex color, e.g. {DEFAULT_BRAND_COLOR}
                </p>
              )}
            </Section>
          </div>
        </div>
      </TabPanel>

      <TabPanel value="documents" activeValue={activeTab}>
        <div className="pt-4">
          <Section
            className="max-w-3xl"
            title={`${isInvoiceCopy ? 'Invoice' : 'Estimate'} Document Copy`}
            description={`Default text printed on every ${isInvoiceCopy ? 'invoice' : 'estimate'} PDF.`}
            action={
              /* Same shared toggle as the Live Preview panel - Estimate and Invoice
                 copy are separate fields (no fallback between them), each printed
                 only on its own document. */
              <PreviewDocToggle value={previewDoc} onChange={setPreviewDoc} ariaLabel="Document copy" />
            }
          >
            <div className="space-y-1.5">
              <Label htmlFor="doc-terms" className="text-xs">Terms &amp; Conditions</Label>
              <Textarea
                id="doc-terms"
                rows={8}
                className="resize-y"
                value={activeTerms}
                onChange={(e) => setActiveTerms(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-notes" className="text-xs">Notes</Label>
              <Textarea
                id="doc-notes"
                rows={8}
                className="resize-y"
                value={activeNotes}
                onChange={(e) => setActiveNotes(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-payment-terms" className="text-xs">Payment Terms</Label>
              <Textarea
                id="doc-payment-terms"
                rows={5}
                className="resize-y"
                placeholder="e.g. Net 30"
                value={activePaymentTerms}
                onChange={(e) => setActivePaymentTerms(e.target.value)}
              />
            </div>
          </Section>
        </div>
      </TabPanel>
    </>
  );
}
