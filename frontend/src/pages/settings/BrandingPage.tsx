import { useEffect, useRef, useState } from 'react';
import { useOrganization, useUpdateOrganization, useUploadLogo } from '@/lib/api/organization';
import { useSettingsBar } from './SettingsLayout';
import { getAccessToken } from '@/lib/supabase';
import { TabsContent } from '@/components/ui/tabs';
import { TabStrip } from '@/components/patterns/TabStrip';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { DEFAULT_BRAND_COLOR } from '@/lib/branding';

const TEMPLATES = [
  { value: 'alpha-classic', label: 'Classic' },
  { value: 'crm-default', label: 'CRM Default' },
];

// One template + brand color drives both documents — this toggle only switches which
// document the preview/copy panel shows, not a second template picker.
const PREVIEW_DOCS = [
  { value: 'estimate', label: 'Estimate' },
  { value: 'invoice', label: 'Invoice' },
] as const;
type PreviewDoc = (typeof PREVIEW_DOCS)[number]['value'];

// #114 — Brand color must be a 6-digit hex; the server enforces the same regex.
const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Shared by the Live Preview panel and the Document Copy tab — same toggle, same options,
 * different aria-label per panel. */
function PreviewDocToggle({ value, onChange, ariaLabel }: { value: PreviewDoc; onChange: (v: PreviewDoc) => void; ariaLabel: string }) {
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      value={value}
      // Guard against Radix's default deselect-on-reclick so exactly one option always stays
      // pressed (same guard toggle-group.stories.tsx's own demo uses).
      onValueChange={(v) => v && onChange(v as PreviewDoc)}
      aria-label={ariaLabel}
    >
      {PREVIEW_DOCS.map((d) => (
        <ToggleGroupItem key={d.value} value={d.value} variant="segmented">
          {d.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export default function BrandingPage() {
  const { data: org } = useOrganization();
  const update = useUpdateOrganization();
  const uploadLogo = useUploadLogo();
  const { registerSaver } = useSettingsBar();
  const fileRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState('branding');
  const [brandColor, setBrandColor] = useState(DEFAULT_BRAND_COLOR);
  const [template, setTemplate] = useState('alpha-classic');
  // Estimate document copy moved here from the Payments & Lists screen — it's the
  // text printed on the document, so it belongs with templates/branding.
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  // Invoice document copy — separate fields, no fallback to the estimate copy above.
  const [invoiceTerms, setInvoiceTerms] = useState('');
  const [invoiceNotes, setInvoiceNotes] = useState('');
  const [invoicePaymentTerms, setInvoicePaymentTerms] = useState('');
  // Which document the live preview (Branding tab) and the copy fields (Document Copy
  // tab) currently show — one template/brand-color setup renders both documents.
  const [previewDoc, setPreviewDoc] = useState<PreviewDoc>('estimate');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // Cache the generated PDF per doc+template+color so re-selecting one is instant.
  const previewCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (org && !loaded) {
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

  // PDF preview (authed fetch → blob URL). Reflects the picked color live (debounced),
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
  // shared toggle currently selects — not a second copy of the JSX per document.
  const isInvoiceCopy = previewDoc === 'invoice';
  const activeTerms = isInvoiceCopy ? invoiceTerms : terms;
  const setActiveTerms = isInvoiceCopy ? setInvoiceTerms : setTerms;
  const activeNotes = isInvoiceCopy ? invoiceNotes : notes;
  const setActiveNotes = isInvoiceCopy ? setInvoiceNotes : setNotes;
  const activePaymentTerms = isInvoiceCopy ? invoicePaymentTerms : paymentTerms;
  const setActivePaymentTerms = isInvoiceCopy ? setInvoicePaymentTerms : setPaymentTerms;

  return (
    <TabStrip
      active={activeTab}
      onChange={setActiveTab}
      tabs={[
        { value: 'branding', label: 'Branding' },
        { value: 'documents', label: 'Document Copy' },
      ]}
    >
      <TabsContent value="branding" className="pt-4">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* LEFT — Document Templates + live preview */}
      <div className="space-y-6">
        <Card className="space-y-3">
          <Heading level={3}>Document Template</Heading>
          <div className="flex gap-3">
            {/* Segmented template-picker toggle group, not a Button-shaped control -
                left raw per the program's non-Button-shape carve-out. */}
            {TEMPLATES.map((t) => (
              <button
                key={t.value}
                onClick={() => setTemplate(t.value)}
                className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                  template === t.value
                    ? 'border-primary bg-primary-subtle text-primary'
                    : 'border-border text-text-secondary hover:bg-background-light'
                }`}
              >
                {t.label}
                {template === t.value && ' ✓'}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <Heading level={3}>
              Live Preview — {TEMPLATES.find((t) => t.value === template)?.label}
            </Heading>
            {/* Switches which document the SAME template + brand color render; it is not a
                second template picker. */}
            <PreviewDocToggle value={previewDoc} onChange={setPreviewDoc} ariaLabel="Preview document" />
          </div>
          {previewLoading ? (
            <div className="flex h-[200px] items-center justify-center gap-2 text-sm text-text-secondary">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
              Generating preview…
            </div>
          ) : previewUrl ? (
            <iframe title="Document preview" src={previewUrl} className="h-[700px] w-full rounded-lg border border-border" />
          ) : (
            <div className="flex h-[200px] items-center justify-center text-sm text-text-secondary">
              Preview unavailable
            </div>
          )}
        </Card>
      </div>

      {/* RIGHT — Brand Identity */}
      <div className="space-y-6">
        <Card className="space-y-4">
          <Heading level={3}>Company Logo</Heading>
          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-border bg-background-light">
              {org?.logo_url ? (
                <img src={org.logo_url} alt="Logo" className="h-full w-full object-contain" />
              ) : (
                <span className="text-xs text-text-secondary">No logo</span>
              )}
            </div>
            <Input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onLogoChange} />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={uploadLogo.isPending}>
              {uploadLogo.isPending ? 'Uploading…' : 'Replace logo'}
            </Button>
          </div>
        </Card>

        <Card className="space-y-4">
          <Heading level={3}>Brand Color</Heading>
          <p className="text-xs text-text-secondary">
            Used as the accent on estimate &amp; invoice PDFs and email headers. The live preview on the left updates as
            you pick, so you can see the effect before saving.
          </p>
          <div className="flex items-center gap-3">
            {/* type="color" renders a native swatch button, not a text box - the Input
                primitive's box styling is shaped for text fields, same reasoning as this
                program's checkbox/radio/range deferrals. Left raw. */}
            <input
              type="color"
              value={brandColor}
              onChange={(e) => setBrandColor(e.target.value)}
              className="h-10 w-14 cursor-pointer rounded border border-border"
            />
            <div className="w-32">
              <Label className="text-xs">Hex</Label>
              <Input
                value={brandColor}
                onChange={(e) => setBrandColor(e.target.value)}
                aria-invalid={!hexValid}
                invalid={!hexValid}
              />
            </div>
          </div>
          <div className="flex gap-1">
            {[1, 0.8, 0.6, 0.4, 0.2].map((o) => (
              <span key={o} className="h-8 w-8 rounded" style={{ backgroundColor: hexValid ? brandColor : undefined, opacity: o }} />
            ))}
          </div>
          {!hexValid && (
            <p className="text-xs text-danger">Enter a 6-digit hex color, e.g. {DEFAULT_BRAND_COLOR}</p>
          )}
        </Card>
      </div>
        </div>
      </TabsContent>

      <TabsContent value="documents" className="pt-4">
        <Card className="max-w-3xl space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Heading level={3}>{isInvoiceCopy ? 'Invoice' : 'Estimate'} Document Copy</Heading>
              <p className="text-xs text-text-secondary">
                Default text printed on every {isInvoiceCopy ? 'invoice' : 'estimate'} PDF.
              </p>
            </div>
            {/* Same shared toggle as the Live Preview panel — Estimate and Invoice copy are
                separate fields (no fallback between them), each printed only on its own document. */}
            <PreviewDocToggle value={previewDoc} onChange={setPreviewDoc} ariaLabel="Document copy" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Terms &amp; Conditions</Label>
            <Textarea rows={8} className="resize-y" value={activeTerms} onChange={(e) => setActiveTerms(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea rows={8} className="resize-y" value={activeNotes} onChange={(e) => setActiveNotes(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Payment Terms</Label>
            <Textarea rows={5} className="resize-y" placeholder="e.g. Net 30" value={activePaymentTerms} onChange={(e) => setActivePaymentTerms(e.target.value)} />
          </div>
        </Card>
      </TabsContent>
    </TabStrip>
  );
}
