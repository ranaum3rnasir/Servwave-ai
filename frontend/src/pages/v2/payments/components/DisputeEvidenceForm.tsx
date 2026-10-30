import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import {
  EVIDENCE_FILE_FIELDS, EVIDENCE_TEXT_FIELDS, disputeEvidenceKeys, paymentsPageKeys, saveDisputeEvidence, setDisputeEvidenceState,
  submitDisputeEvidence,
  type DisputeEvidenceState, type EvidenceFile, type EvidenceFileField,
} from '@/lib/api/paymentsPage';
import { useAuthStore } from '@/stores/auth.store';
import { extractApiError, formatCurrency } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { useAppAbility } from '@/contexts/AbilityContext';
import { DateField } from '@/ui-kit/components/form/dateField';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Button } from '@/ui-kit/components/ui/button';
import { ConfirmDialog } from '@/ui-kit/components/ui/confirmDialog';
import { toast } from '@/ui-kit/components/ui/sonner';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';
import { SheetBody, SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Textarea } from '@/ui-kit/components/ui/textarea';

import { InfoPopover } from '../../_shared/infoPopover';
import { InvoiceFilePicker } from './InvoiceFilePicker';
import { fetchInvoiceFiles, invoiceFilesKey, isEvidenceMime, type InvoiceFileItem } from './invoiceFiles';
import { FILE_LABELS, formatSize, megabytes, typeLabel } from './evidenceFormat';

const PHONE_BUTTON = 'max-sm:h-11 touch:h-11';
const WRONG_TYPE = 'Evidence must be a PDF, JPG or PNG. Save it as a PDF and attach that.';
const ACCEPT = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const COUNTER_FROM = 0.9;

type Files = Record<string, EvidenceFile | null>;
type Text = Record<string, string>;

const rowId = (field: string) => `dispute-evidence-${field}`;

const TEXT_LABELS: Record<string, string> = {
  uncategorized_text: 'Your explanation',
  product_description: 'Product or service',
  service_date: 'Service date',
  customer_name: 'Customer name',
  customer_email_address: 'Customer email',
};
const labelOfField = (field: string): string =>
  (FILE_LABELS as Record<string, string>)[field] ?? TEXT_LABELS[field] ?? 'This field';
const KNOWN_FIELDS = new Set<string>([...EVIDENCE_FILE_FIELDS, ...EVIDENCE_TEXT_FIELDS]);

const REFUSED_FILE = 'This file was refused. Replace it or remove it.';
const STALE_MESSAGE = 'Someone changed this evidence. Reload to see it.';
const EMPTY_SAVED = 'Saved, but there is nothing in it yet. Add a file or write an explanation.';

interface FieldProblem { error: string; field?: string }

/** The problems an API answer carries: a list, or one with a field, or none that name a field. */
function problemsOf(err: unknown): FieldProblem[] {
  const body = (err as { response?: { data?: { error?: string; field?: string; errors?: FieldProblem[] } } })?.response?.data;
  if (Array.isArray(body?.errors) && body!.errors.length) return body!.errors.filter((p) => typeof p?.error === 'string');
  if (body?.error) return [{ error: body.error, field: body.field }];
  return [];
}

type Rejection = Partial<DisputeEvidenceState> & { error?: string; field?: string; draft_saved?: boolean };

/** The body of a refused save, when the server stored the draft all the same and so sends the form as it now is. */
function storedDraftOf(err: unknown): Rejection | null {
  const body = (err as { response?: { data?: Rejection } })?.response?.data;
  return body?.draft_saved === true && typeof body.form?.version === 'number' && body.dispute ? body : null;
}

/** The file's type from the browser, falling back to its extension where the browser says nothing. */
function mimeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : '';
}

const initialFiles = (data: DisputeEvidenceState): Files =>
  Object.fromEntries(EVIDENCE_FILE_FIELDS.map((f) => [f, data.form.files[f] ?? null]));
const initialText = (data: DisputeEvidenceState): Text =>
  Object.fromEntries(EVIDENCE_TEXT_FIELDS.map((f) => [f, data.form.text[f] || data.form.defaults[f] || '']));

/** Two forms are the same when they hold the same files and the same words. */
const snapshot = (files: Files, text: Text) =>
  JSON.stringify([EVIDENCE_FILE_FIELDS.map((f) => files[f]?.attachment_id ?? null), EVIDENCE_TEXT_FIELDS.map((f) => text[f] ?? '')]);

/**
 * The files and the words that answer a dispute (payments go-live P11), hosted by the Respond view. Going back is the
 * drawer's own Back (it asks first when this form holds unsaved work), so the form has no Back of its own.
 */
export function DisputeEvidenceForm({
  data, onDirtyChange, onReload, onSubmitted,
}: {
  data: DisputeEvidenceState;
  onDirtyChange: (dirty: boolean) => void;
  /** The evidence was sent; the host leaves this view. */
  onSubmitted: () => void;
  /** Reads the dispute again and starts the form over from it. */
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const orgId = useAuthStore((s) => s.user?.organization_id);
  const ability = useAppAbility();
  const mayUpload = ability.can('create', 'Attachment');
  const invoiceId = data.dispute.invoice?.id ?? null;

  const [files, setFiles] = useState<Files>(() => initialFiles(data));
  const [text, setText] = useState<Text>(() => initialText(data));
  const [base, setBase] = useState(() => snapshot(initialFiles(data), initialText(data)));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [summary, setSummary] = useState<FieldProblem[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const submitButton = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ field: string; n: number } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [picking, setPicking] = useState<EvidenceFileField | null>(null);
  const uploadInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const dirty = snapshot(files, text) !== base;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const setFile = (field: string, value: EvidenceFile | null) => {
    setFiles((prev) => ({ ...prev, [field]: value }));
    setRowErrors((prev) => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const usedIn = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of EVIDENCE_FILE_FIELDS) {
      const held = files[f];
      if (held && f !== picking) out[held.attachment_id] = FILE_LABELS[f];
    }
    return out;
  }, [files, picking]);

  const choose = (field: EvidenceFileField) => setPicking(field);

  const onUploadPicked = async (field: EvidenceFileField, file: File | undefined) => {
    if (!file || !invoiceId) return;
    if (!isEvidenceMime(mimeOf(file))) {
      setRowErrors((prev) => ({ ...prev, [field]: WRONG_TYPE }));
      return;
    }
    setRowErrors((prev) => {
      const next = { ...prev };
      delete next[field];
      return next;
    });
    setUploading(field);
    try {
      const before = new Set((await queryClient.fetchQuery({ queryKey: invoiceFilesKey(invoiceId), queryFn: () => fetchInvoiceFiles(invoiceId), staleTime: 0 })).map((a) => a.id));
      await uploadAttachment({ entityType: 'invoice', entityId: invoiceId, file });
      const after = await queryClient.fetchQuery({ queryKey: invoiceFilesKey(invoiceId), queryFn: () => fetchInvoiceFiles(invoiceId), staleTime: 0 });
      const fresh = after.filter((a) => !before.has(a.id));
      const made = fresh.find((a) => a.file_name === file.name) ?? fresh[0];
      if (!made) throw new Error('missing');
      setFile(field, toEvidenceFile(made));
    } catch {
      setRowErrors((prev) => ({ ...prev, [field]: 'The file could not be uploaded. Try again.' }));
    } finally {
      setUploading(null);
    }
  };

  // A failed save takes the person to the field: scrolled to, focused, marked.
  useEffect(() => {
    if (!focusTarget) return;
    const el = document.getElementById(rowId(focusTarget.field));
    el?.scrollIntoView?.({ block: 'center' });
    el?.focus();
  }, [focusTarget]);

  const clearProblems = () => {
    setRowErrors({});
    setFormError(null);
    setStale(false);
    setSummary([]);
    setNotice(null);
  };

  /**
   * A refused save whose draft is stored: the form's new version and files come from the answer (a retry then cannot
   * meet the version this very save moved on), the message lands beside the field it names, and a file the card
   * network refused is marked as refused beside its own row.
   */
  const failStoredDraft = (body: Rejection, sentSnapshot: string) => {
    const { error, field, ...rest } = body;
    const { staged: _staged, warnings: _warnings, sent: _sent, draft_saved: _draft, errors: _errors, ...state } = rest as Record<string, unknown>;
    setDisputeEvidenceState(queryClient, orgId, data.dispute.id, state as unknown as DisputeEvidenceState);
    setBase(sentSnapshot);
    const words = error || 'The evidence could not be saved. Try again.';
    const named = field && KNOWN_FIELDS.has(field) ? field : null;
    const refused = EVIDENCE_FILE_FIELDS.filter((f) => body.form?.files[f]?.refused);
    const byField: Record<string, string> = {};
    if (named) byField[named] = words;
    for (const f of refused) byField[f] ??= named ? REFUSED_FILE : words;
    const first = named ?? refused[0] ?? null;
    if (!first) {
      setFormError(words);
      return;
    }
    setRowErrors(byField);
    setFocusTarget({ field: first, n: Date.now() });
    if (field && !named) setFormError(words);
  };

  const failSave = (err: unknown, sentSnapshot: string) => {
    const stored = storedDraftOf(err);
    if (stored) {
      failStoredDraft(stored, sentSnapshot);
      return;
    }
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 409) {
      const words = problemsOf(err)[0]?.error ?? '';
      setStale(true);
      setFormError(/someone changed/i.test(words) || !words ? STALE_MESSAGE : words);
      return;
    }
    const problems = problemsOf(err);
    const named = problems.filter((p) => p.field && KNOWN_FIELDS.has(p.field));
    if (named.length === 0) {
      setFormError(extractApiError(err, 'The evidence could not be saved. Try again.'));
      return;
    }
    const byField: Record<string, string> = {};
    for (const p of named) byField[p.field!] ??= p.error;
    setRowErrors(byField);
    setFocusTarget({ field: named[0]!.field!, n: Date.now() });
    if (named.length > 1) setSummary(named);
    const loose = problems.find((p) => !p.field || !KNOWN_FIELDS.has(p.field));
    if (loose && named.length === 1) setFormError(loose.error);
  };

  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    clearProblems();
    const sentSnapshot = snapshot(files, text);
    try {
      const result = await saveDisputeEvidence(data.dispute.id, {
        version: data.form.version,
        files: Object.fromEntries(EVIDENCE_FILE_FIELDS.map((f) => [f, files[f]?.attachment_id ?? null])),
        text: Object.fromEntries(EVIDENCE_TEXT_FIELDS.map((f) => [f, text[f] ?? ''])),
      });
      const { staged: _staged, warnings, ...state } = result;
      setDisputeEvidenceState(queryClient, orgId, data.dispute.id, state);
      setBase(sentSnapshot);
      // The server has now counted the pages of what was sent.
      setFiles((prev) => Object.fromEntries(EVIDENCE_FILE_FIELDS.map((f) => {
        const held = prev[f] ?? null;
        const counted = state.form.files[f];
        return [f, held && counted && counted.attachment_id === held.attachment_id ? counted : held];
      })) as Files);
      setNotice(warnings?.includes('empty') ? EMPTY_SAVED : 'Saved');
    } catch (err) {
      failSave(err, sentSnapshot);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const submit = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitDisputeEvidence(data.dispute.id, data.form.version);
      toast.success('Evidence submitted. The dispute is under review');
      setDisputeEvidenceState(queryClient, orgId, data.dispute.id, result);
      void queryClient.invalidateQueries({ queryKey: paymentsPageKeys.all });
      setConfirmOpen(false);
      onSubmitted();
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      const words = extractApiError(err, 'The evidence could not be sent. Try again.');
      if (status === 502 && /being checked/i.test(words)) {
        // The card network may have it: not a failure, and not yet known. Say so and read the dispute again.
        setConfirmOpen(false);
        setNotice(words);
        void queryClient.invalidateQueries({ queryKey: disputeEvidenceKeys.one(orgId, data.dispute.id) });
      } else {
        setSubmitError(words);
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const serverSnap = snapshot(
    Object.fromEntries(EVIDENCE_FILE_FIELDS.map((f) => [f, data.form.files[f] ?? null])),
    Object.fromEntries(EVIDENCE_TEXT_FIELDS.map((f) => [f, data.form.text[f] ?? ''])),
  );
  const unsaved = snapshot(files, text) !== serverSnap;
  const canSubmit = data.can_submit && !unsaved && !saving;

  const bytes = EVIDENCE_FILE_FIELDS.reduce((n, f) => n + (files[f]?.size_bytes ?? 0), 0);
  const sameFiles = EVIDENCE_FILE_FIELDS.every((f) => (files[f]?.attachment_id ?? null) === (data.form.files[f]?.attachment_id ?? null));
  const pagesKnown = sameFiles && data.totals.pages > 0;
  const overBytes = bytes > data.limits.max_bytes;
  const overPages = pagesKnown && data.totals.pages > data.limits.max_pages;
  const chars = EVIDENCE_TEXT_FIELDS.reduce((n, f) => n + (text[f]?.length ?? 0), 0);

  return (
    <>
      <SheetBody className="flex flex-col gap-6 px-4 pb-4">
        {summary.length > 1 && (
          <Alert tone="danger" role="alert">
            <div className="flex flex-col gap-1">
              <p className="font-semibold">{`${summary.length} things to fix`}</p>
              <ul className="flex flex-col gap-1">
                {summary.map((p) => (
                  <li key={p.field}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-auto min-h-11 justify-start whitespace-normal px-0 text-left underline underline-offset-2 hover:bg-transparent sm:min-h-0"
                      onClick={() => setFocusTarget({ field: p.field!, n: Date.now() })}
                    >
                      {`${labelOfField(p.field!)}: ${p.error}`}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </Alert>
        )}
        {formError && (
          <Alert tone="danger" role={summary.length > 1 ? undefined : 'alert'}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{formError}</span>
              {stale && <Button type="button" size="sm" variant="outline" className={PHONE_BUTTON} onClick={onReload}>Reload</Button>}
            </div>
          </Alert>
        )}
        {notice && (
          <Alert tone="neutral" role="status">
            <span>{notice}</span>
          </Alert>
        )}
        <section aria-label="Files" className="flex flex-col gap-3">
          <div className="flex items-center gap-1">
            <h3 className="text-sm font-semibold">Files</h3>
            <InfoPopover label="evidence files">
              Combine documents of one kind into one file (for example all emails in one PDF). One file per row. PDF, JPG or PNG, 4.5 MB for everything together.
            </InfoPopover>
          </div>
          <ul className="flex flex-col gap-3">
            {EVIDENCE_FILE_FIELDS.map((field) => (
              <FileRow
                key={field}
                field={field}
                held={files[field] ?? null}
                recommended={data.recommended.includes(field)}
                error={rowErrors[field]}
                busy={uploading === field}
                disabled={uploading !== null}
                mayUpload={mayUpload && Boolean(invoiceId)}
                mayChoose={Boolean(invoiceId)}
                inputRef={(el) => { uploadInputs.current[field] = el; }}
                onUpload={() => uploadInputs.current[field]?.click()}
                onFile={(file) => void onUploadPicked(field, file)}
                onChoose={() => choose(field)}
                onRemove={() => setFile(field, null)}
              />
            ))}
          </ul>
          <div className="flex flex-col gap-1 text-sm">
            <p data-tone={overBytes || overPages ? 'danger' : undefined} className={overBytes || overPages ? 'font-medium text-danger' : 'text-text-secondary'}>
              {`${megabytes(bytes)} MB of ${megabytes(data.limits.max_bytes)} MB${pagesKnown ? ` · ${data.totals.pages} of ${data.limits.max_pages} pages` : ''}`}
            </p>
            {overBytes && <p className="font-medium text-danger">Over the 4.5 MB limit. Remove a file or save a smaller one.</p>}
            {overPages && <p className="font-medium text-danger">Over the page limit. Combine or shorten the documents.</p>}
          </div>
        </section>

        <section aria-label="Details" className="flex flex-col gap-4">
          <TextRow label="Your explanation" field="uncategorized_text" error={rowErrors.uncategorized_text}>
            <Textarea
              id={rowId('uncategorized_text')}
              {...invalidProps('uncategorized_text', rowErrors.uncategorized_text)}
              className="min-h-40"
              value={text.uncategorized_text ?? ''}
              onChange={(e) => setText((p) => ({ ...p, uncategorized_text: e.target.value }))}
            />
            {chars >= data.limits.max_chars * COUNTER_FROM && (
              <p className="text-xs text-text-secondary tabular-nums">{`${chars.toLocaleString('en-US')} of ${data.limits.max_chars.toLocaleString('en-US')} characters`}</p>
            )}
          </TextRow>
          <TextRow label="Product or service" field="product_description" error={rowErrors.product_description}>
            <Textarea
              id={rowId('product_description')}
              {...invalidProps('product_description', rowErrors.product_description)}
              value={text.product_description ?? ''}
              onChange={(e) => setText((p) => ({ ...p, product_description: e.target.value }))}
            />
          </TextRow>
          <TextRow label="Service date" field="service_date" error={rowErrors.service_date}>
            <DateField
              id={rowId('service_date')}
              inputClassName="max-sm:h-11"
              {...invalidProps('service_date', rowErrors.service_date)}
              value={text.service_date ?? ''}
              onChange={(v) => setText((p) => ({ ...p, service_date: v }))}
            />
          </TextRow>
          <TextRow label="Customer name" field="customer_name" error={rowErrors.customer_name}>
            <Input
              id={rowId('customer_name')}
              {...invalidProps('customer_name', rowErrors.customer_name)}
              autoComplete="off"
              className="max-sm:h-11"
              value={text.customer_name ?? ''}
              onChange={(e) => setText((p) => ({ ...p, customer_name: e.target.value }))}
            />
          </TextRow>
          <TextRow label="Customer email" field="customer_email_address" error={rowErrors.customer_email_address}>
            <Input
              id={rowId('customer_email_address')}
              {...invalidProps('customer_email_address', rowErrors.customer_email_address)}
              kind="email"
              className="max-sm:h-11"
              personalAutofill={false}
              value={text.customer_email_address ?? ''}
              onChange={(e) => setText((p) => ({ ...p, customer_email_address: e.target.value }))}
            />
          </TextRow>
        </section>
      </SheetBody>

      <SheetFooter className="max-sm:flex-col max-sm:[&>button]:w-full">
        <Button type="button" variant="outline" className={PHONE_BUTTON} isLoading={saving} onClick={() => void save()}>Save draft</Button>
        <Button
          ref={submitButton}
          type="button"
          className={PHONE_BUTTON}
          disabled={!canSubmit}
          onClick={() => { setSubmitError(null); setConfirmOpen(true); }}
        >
          Submit evidence
        </Button>
      </SheetFooter>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          // The confirm has no trigger of its own, so focus goes back to the button that asked.
          if (!open) setTimeout(() => submitButton.current?.focus(), 0);
        }}
        title="Submit evidence"
        description={`Send your evidence for ${formatCurrency(data.dispute.amount)}${data.dispute.invoice ? ` on invoice ${data.dispute.invoice.number}` : ''} now? You cannot add more after you submit.`}
        confirmLabel="Submit evidence"
        isPending={submitting}
        onConfirm={() => void submit()}
      >
        {submitError && <Alert tone="danger" role="alert"><span>{submitError}</span></Alert>}
      </ConfirmDialog>

      {invoiceId && (
        <InvoiceFilePicker
          open={picking !== null}
          onOpenChange={(open) => { if (!open) setPicking(null); }}
          invoiceId={invoiceId}
          usedIn={usedIn}
          onPick={(item) => {
            if (picking) setFile(picking, toEvidenceFile(item));
            setPicking(null);
          }}
        />
      )}
    </>
  );
}

function toEvidenceFile(item: InvoiceFileItem): EvidenceFile {
  return { attachment_id: item.id, file_name: item.file_name, mime: item.file_type, size_bytes: item.file_size, page_count: null };
}

function TextRow({ label, field, error, children }: { label: string; field: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" data-field={field}>
      <Label htmlFor={rowId(field)}>{label}</Label>
      {children}
      {error && <p id={`${rowId(field)}-error`} className="text-sm text-danger">{error}</p>}
    </div>
  );
}

/** Props that mark a text control invalid and tie it to the message beside it. */
const invalidProps = (field: string, error: string | undefined) =>
  error ? { 'aria-invalid': true as const, 'aria-describedby': `${rowId(field)}-error` } : {};

function FileRow({
  field, held, recommended, error, busy, disabled, mayUpload, mayChoose, inputRef, onUpload, onFile, onChoose, onRemove,
}: {
  field: EvidenceFileField;
  held: EvidenceFile | null;
  recommended: boolean;
  error: string | undefined;
  busy: boolean;
  disabled: boolean;
  mayUpload: boolean;
  mayChoose: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onUpload: () => void;
  onFile: (file: File | undefined) => void;
  onChoose: () => void;
  onRemove: () => void;
}) {
  const label = FILE_LABELS[field];
  const labelId = `${rowId(field)}-label`;
  const errorId = `${rowId(field)}-error`;
  // The first control of the row carries the id a failed save focuses.
  const first = held ? 'replace' : mayUpload ? 'upload' : 'choose';
  const idFor = (which: string) => (first === which ? rowId(field) : undefined);
  const buttons = 'max-sm:h-11 touch:h-11 max-sm:flex-1';
  return (
    <li
      role="group"
      aria-labelledby={labelId}
      className={`flex flex-col gap-2 rounded-lg border p-3 ${error ? 'border-danger' : ''}`}
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span id={labelId} className="text-sm font-medium">{label}</span>
          {recommended && <Badge variant="softBlue" size="sm">Recommended</Badge>}
        </div>
        {held && (
          <p className="break-all text-sm">
            <span>{held.file_name}</span>
            <span className="block text-xs text-text-secondary">{`${formatSize(held.size_bytes)} · ${typeLabel(held.mime)}`}</span>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {held ? (
            <>
              <Button
                id={idFor('replace')} type="button" size="sm" variant="outline" className={buttons} disabled={disabled}
                aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                onClick={mayUpload ? onUpload : onChoose}
              >
                Replace
              </Button>
              <Button type="button" size="sm" variant="ghost" className={buttons} disabled={disabled} onClick={onRemove}>Remove</Button>
            </>
          ) : (
            <>
              {mayUpload && (
                <Button
                  id={idFor('upload')} type="button" size="sm" variant="outline" className={buttons} disabled={disabled} isLoading={busy}
                  aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                  onClick={onUpload}
                >
                  Upload
                </Button>
              )}
              {mayChoose && (
                <Button
                  id={idFor('choose')} type="button" size="sm" variant="outline" className={buttons} disabled={disabled}
                  aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
                  onClick={onChoose}
                >
                  Choose from invoice files
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {error && <p id={errorId} className="text-sm text-danger">{error}</p>}
      {mayUpload && (
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          aria-label={`Choose a file for ${label}`}
          tabIndex={-1}
          className="sr-only"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      )}
    </li>
  );
}
