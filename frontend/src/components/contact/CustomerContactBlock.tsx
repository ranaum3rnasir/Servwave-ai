import { useId, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Copy, Mail, MapPin, MessageSquare, Pencil, Phone } from 'lucide-react';

import { cn, getInitials } from '@/lib/utils';
import { customerDisplayName } from '@/lib/customer-name';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import type { DialerEntityContext } from '@/stores/dialer.store';
import { ActionLink } from '@/components/ui/action-link';
import { Button } from '@/ui-kit/components/ui/button';
import { ChoiceMenu } from '@/ui-kit/components/ui/choiceMenu';
import { NOT_SELECTABLE, blockCopy } from './ContactText';
import type { ContactRecordRef, RecordContactEntry } from '@/lib/api/recordContactEntries';
import { ContactEntryDialog, type ContactEntryTarget } from './ContactEntryDialog';
import { NameEntryDialog, type NameField, type NameKind } from './NameEntryDialog';
import { smsHref, telHref, textPath } from './contactHrefs';
import { useContactPolicyInput } from './useContactPolicyInput';
import { customerEmailsOf, customerPhonesOf, type BlockCustomer } from './customerContactLists';
import {
  CALL_NOT_SET_UP_MESSAGE,
  CLOSED_LEAD_LINE,
  contactEntryActionsDisplay,
  contactPencilDisplay,
  customerEmailDisplay,
  customerNameDisplay,
  editCustomerDisplay,
  entryMarkers,
  phoneDisplay,
  type ContactPolicyInput,
  type PencilRecord,
  type PhoneKind,
} from './contactDisplayPolicy';

/**
 * The customer contact block (Roles & Permissions, PRD 5): the customer's name, company, every phone, every
 * email and the service address, drawn through the contact display policy. The job page's Overview tab and
 * its header use it, and so does the lead page; later slices bring it to the other places a customer's details show.
 *
 * Nothing here decides what a value may do: `contactDisplayPolicy` does, from the person's switches and the
 * company's phone service. This file only draws the answer.
 *
 * On a job or a lead, the block also draws the record's own phones and emails (entries added with the pencil), each marked
 * "This job only" / "This lead only", and the pencil that adds one or replaces one of the customer's. A replaced value
 * stands where the customer's was, marked "Changed on this job" / "Changed on this lead", with the customer's value one
 * tap away. The customer record is never written from here.
 *
 * A person with Edit jobs (Edit leads on a lead) also gets the pencil on the name and the company name. A changed name
 * stands in the customer's place, marked the same way, with the customer's own one tap away. Phones and emails are the
 * contact details switch's too; names are not.
 *
 * A Won or Lost lead is closed: its block has no pencil, Edit or Remove for anyone, and one line under the entries
 * says to reopen the lead. A locked job's block has none of them either for a person without Change locked jobs (the
 * job page says why once). The customer's own record never locks, so "Edit customer" stays.
 */

// ─── One value ─────────────────────────────────────────────────────────────────

/** A call is attributed exactly as before: the Text-only `textCarriesLead` hint (SPEC-4 §6.8) stays off it. */
function callOnly(context: DialerEntityContext | undefined): DialerEntityContext | undefined {
  if (!context) return context;
  const { textCarriesLead: _textOnly, ...call } = context;
  return call;
}

function CopyValueButton({ value, label, reveal = false }: { value: string; label: string; reveal?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      // In a table cell the control stays out of the way until the cell is hovered (it is always there on touch).
      className={cn('size-6 shrink-0', reveal && !copied && 'hover-reveal')}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? <span className="text-[10px]">Copied!</span> : <Copy />}
    </Button>
  );
}

interface PhoneValueProps {
  kind: PhoneKind;
  phone: string;
  extension?: string | null;
  /** Who it is, for accessible names ("Call Dana Reyes"). */
  name?: string;
  /** The record the number is tapped from, so the call lands on it. */
  context?: DialerEntityContext;
  /** A number that belongs to the job only, not to the customer: Text opens the composer by the number itself. */
  recordOnly?: boolean;
  className?: string;
  /**
   * A value in a table cell: it clips with an ellipsis when the column is narrow (the full number on hover) and its
   * copy control shows on hover. Which of its actions exist is still the policy's.
   */
  inCell?: boolean;
}

/** A phone number as the policy allows: tappable, copyable and selectable only as far as it says. */
export function PhoneValue({ kind, phone, extension, name, context, recordOnly, className, inCell = false }: PhoneValueProps) {
  const policy = useContactPolicyInput();
  const navigate = useNavigate();
  const d = phoneDisplay(kind, phone, extension, policy);
  // The digits stay in the text for a screen reader whatever the switches say.
  const text = (
    <span
      className={cn(inCell && 'truncate', !d.selectable && NOT_SELECTABLE, className)}
      title={inCell ? d.text : undefined}
      onCopy={d.selectable ? undefined : blockCopy}
    >
      {d.text}
    </span>
  );

  let number: ReactNode = text;
  if (d.tap === 'native_link') {
    number = (
      <ActionLink href={telHref(phone)} className={cn(inCell && 'min-w-0')}>
        {text}
      </ActionLink>
    );
  } else if (d.tap === 'in_app_dial') {
    number = (
      <ChoiceMenu
        title={name ? `${name}, ${d.text}` : d.text}
        trigger={
          <Button variant="link" size="sm" className={cn('h-auto px-0 font-normal', inCell && 'min-w-0')}>
            {text}
          </Button>
        }
        options={[
          {
            key: 'call',
            label: 'Call',
            icon: <Phone className="size-4" aria-hidden />,
            onSelect: () => requestCall(phone, callOnly(context)),
          },
          {
            key: 'text',
            label: 'Text',
            icon: <MessageSquare className="size-4" aria-hidden />,
            // A job-only number is the job's, not the customer's: Text goes by the number, with no customer record.
            onSelect: () =>
              navigate(
                textPath(phone, recordOnly ? { customerName: name } : context, { viewCustomers: policy.switches.viewCustomers }),
              ),
          },
        ]}
      />
    );
  }

  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', inCell && 'max-w-full')}>
      {number}
      {d.copyButton && <CopyValueButton value={phone} label="Copy phone number" reveal={inCell} />}
    </span>
  );
}

interface EmailValueProps {
  email: string;
  className?: string;
  /**
   * Lets a long address break across lines instead of being cut off with an ellipsis, for a header that must keep
   * the whole address on screen.
   */
  wrap?: boolean;
  /** A value in a table cell: it clips with an ellipsis (the full address on hover) and its copy control shows on hover. */
  inCell?: boolean;
  /**
   * Opens the in-app email composer to this address. It stands in for the device's mail link, so it is a way to
   * write to the customer from the app rather than a way to take the address off the page: the copy switch decides
   * whether the address can be selected or copied, not whether the composer opens.
   */
  onCompose?: () => void;
}

/** A customer email as the policy allows: a mail link, copyable and selectable only as far as it says. */
export function EmailValue({ email, className, wrap = false, inCell = false, onCompose }: EmailValueProps) {
  const policy = useContactPolicyInput();
  const d = customerEmailDisplay(email, policy);
  const fit = wrap ? 'break-all whitespace-normal' : 'truncate';
  const text = (
    <span
      className={cn(fit, !d.selectable && NOT_SELECTABLE, className)}
      title={inCell ? email : undefined}
      onCopy={d.selectable ? undefined : blockCopy}
    >
      {d.text}
    </span>
  );
  let address: ReactNode = text;
  if (onCompose) {
    address = (
      <Button variant="link" size="sm" className="h-auto min-w-0 justify-start px-0 font-normal" onClick={onCompose}>
        {text}
      </Button>
    );
  } else if (d.tap === 'mail_link' && !inCell) {
    // The customer page and the document headers: the address is running text on its own line, not a table control.
    address = (
      <ActionLink href={`mailto:${email}`} className={cn('min-w-0', fit)} title={email}>
        {text}
      </ActionLink>
    );
  } else if (d.tap === 'mail_link') {
    // A table cell: the kit's link Button on a real mailto anchor, so it has the touch height (44 px on a phone) and
    // `min-w-0` and the address shrinks with its cell and clips with an ellipsis. A bare anchor inside this inline-flex
    // wrapper was a flex item one text line tall, under the 24 px touch floor, and its text overran the screen at 200%.
    address = (
      <Button variant="link" size="sm" asChild className="h-auto min-w-0 px-0 font-normal">
        <ActionLink href={`mailto:${email}`} title={email}>
          {text}
        </ActionLink>
      </Button>
    );
  }
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', inCell && 'max-w-full')}>
      {address}
      {d.copyButton && <CopyValueButton value={email} label="Copy email address" reveal={inCell} />}
    </span>
  );
}

// ─── The primary phone and email of a document ──────────────────────────────

interface PrimaryContactLinesProps {
  /** The customer, as an estimate or an invoice carries them: the primary phone and the primary email only. */
  customer: { phone?: string | null; email?: string | null };
  /** Who it is, for accessible names ("Call Dana Reyes"). */
  name: string;
  /** The record and the customer the number is tapped from, so the call lands on them. */
  context: DialerEntityContext;
  /** A small icon before each line. */
  icons?: boolean;
  /** Layout for each line. */
  lineClassName?: string;
}

/**
 * The customer's primary phone and primary email on the estimate header and the invoice page: the two lines of
 * the full block that these documents carry, drawn through the same policy. Renders nothing for a value the
 * customer does not have.
 */
export function PrimaryContactLines({ customer, name, context, icons = false, lineClassName }: PrimaryContactLinesProps) {
  return (
    <>
      {customer.phone && (
        <span className={cn('flex min-w-0 items-center gap-1.5', lineClassName)}>
          {icons && <Phone className="size-3.5 shrink-0" aria-hidden />}
          <PhoneValue kind="customer_phone" phone={customer.phone} name={name} context={context} />
        </span>
      )}
      {customer.email && (
        <span className={cn('flex min-w-0 max-w-full items-center gap-1.5', lineClassName)}>
          {icons && <Mail className="size-3.5 shrink-0" aria-hidden />}
          <EmailValue email={customer.email} wrap />
        </span>
      )}
    </>
  );
}

// ─── The block ─────────────────────────────────────────────────────────────────

interface CustomerContactBlockProps {
  customer: BlockCustomer;
  /** The record the block sits on, so a call or text is attached to it. */
  context: DialerEntityContext;
  serviceAddress?: string | null;
  /** The Call, Text and Email actions for the primary phone and email. */
  showActions?: boolean;
  /** "Edit customer": the way into the customer record's own edit form, for a person who may edit it. */
  editCustomer?: boolean;
  /**
   * The job or lead the block sits on, with its own entries: the block draws them and the pencil that adds one. On a
   * lead, `mayEdit` is the server's answer for this lead (Edit leads, or the creator still on it), and `closed` is a Won
   * or Lost lead, which takes no pencil from anyone and says so under its entries. `onReopen` is passed only for a person
   * who may reopen the lead (S05.19): it adds a Reopen lead button beside that line. On a job, `locked` is the server's
   * answer for this person: a locked job takes no pencil from someone without Change locked jobs.
   */
  record?: ({ kind: 'job'; locked?: boolean } | { kind: 'lead'; mayEdit: boolean; closed?: boolean; onReopen?: () => void }) & { id: string };
  entries?: RecordContactEntry[];
  className?: string;
}

export function CustomerContactBlock({ customer, context, serviceAddress, showActions = false, editCustomer = false, record, entries = [], className }: CustomerContactBlockProps) {
  const policy = useContactPolicyInput();
  const [adding, setAdding] = useState<{ kind: 'PHONE' | 'EMAIL'; target: ContactEntryTarget | null; entry?: RecordContactEntry } | null>(null);
  const [naming, setNaming] = useState<'name' | 'company name' | null>(null);
  const pencilRecord: PencilRecord = record?.kind === 'lead' ? { kind: 'lead', mayEdit: record.mayEdit, closed: record.closed } : { kind: 'job', locked: record?.locked };
  const pencils = record ? contactPencilDisplay(policy, pencilRecord) : { phoneEmail: false, name: false };
  const word = record?.kind ?? 'job';
  const recordRef: ContactRecordRef | null = record ? { kind: record.kind, id: record.id } : null;
  const markers = entryMarkers(word);
  const pencil = pencils.phoneEmail;
  // The job's own name and company stand where the customer's are; the customer's are kept for the tap that shows them.
  const nameEntry = (kind: NameKind) => entries.find((e) => e.kind === kind);
  const effective = {
    first_name: nameEntry('FIRST_NAME')?.value ?? customer.first_name,
    last_name: nameEntry('LAST_NAME')?.value ?? customer.last_name,
    company_name: nameEntry('COMPANY_NAME')?.value ?? customer.company_name,
  };
  const name = customerDisplayName(effective);
  const customerName = customerDisplayName(customer);
  const nameChanged = Boolean(nameEntry('FIRST_NAME') || nameEntry('LAST_NAME'));
  const companyChanged = Boolean(nameEntry('COMPANY_NAME'));
  const nameFields = (kinds: NameKind[]): NameField[] =>
    kinds.map((kind) => ({
      kind,
      label: kind === 'FIRST_NAME' ? 'First name' : kind === 'LAST_NAME' ? 'Last name' : 'Company name',
      customerValue: (kind === 'FIRST_NAME' ? customer.first_name : kind === 'LAST_NAME' ? customer.last_name : customer.company_name)?.trim() ?? '',
      entry: nameEntry(kind),
    }));
  // Phones and emails only: a name entry is drawn on the name and the company, not as a line of its own.
  const contactEntries = entries.filter((entry) => entry.kind === 'PHONE' || entry.kind === 'EMAIL');
  const callContext: DialerEntityContext = { ...context, customerId: customer.id, customerName: name };
  const phones = customerPhonesOf(customer);
  const emails = customerEmailsOf(customer);
  const primaryPhone = phones.find((p) => p.is_primary) ?? phones[0];
  const primaryEmail = emails.find((e) => e.is_primary) ?? emails[0];
  const nameLink = customerNameDisplay(policy).link;
  const showEditCustomer = editCustomer && editCustomerDisplay(policy).show;
  // A replaced customer value is drawn in its own place above; the rest of the entries follow under the customer's.
  // Edit and Remove on an entry made on the job, for anyone who holds the pencil for it, whoever added it.
  const entryPencil = (entry: RecordContactEntry) =>
    record && (entry.kind === 'PHONE' || entry.kind === 'EMAIL') && contactEntryActionsDisplay(policy, entry, pencilRecord).edit
      ? () => setAdding({ kind: entry.kind as 'PHONE' | 'EMAIL', target: null, entry })
      : undefined;
  const standsInPlace = new Set<string>();
  for (const p of phones) standsInPlace.add(changedEntryFor(contactEntries, 'PHONE', p.phone)?.id ?? '');
  for (const e of emails) standsInPlace.add(changedEntryFor(contactEntries, 'EMAIL', e.email)?.id ?? '');

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-3">
        <div className="bg-primary ring-surface-light flex size-10 shrink-0 items-center justify-center rounded-full shadow-sm ring-2">
          <span className="text-on-fill text-xs font-semibold tracking-wide">{getInitials(name)}</span>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-1.5">
            {nameLink ? (
              <Link to={`/customers/${customer.id}`} className="text-primary text-sm font-medium hover:underline">
                {name}
              </Link>
            ) : (
              <p className="text-text-primary text-sm font-medium">{name}</p>
            )}
            {pencils.name && <PencilButton label={`Change the name for this ${word}`} onClick={() => setNaming('name')} />}
            {nameChanged && <ChangedNote noun="name" customerValue={customerName} marker={markers.changed} />}
          </div>
          {(effective.company_name || pencils.name) && (
            <div className="text-text-secondary mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              <p>{effective.company_name || 'No company'}</p>
              {pencils.name && (
                <PencilButton
                  label={effective.company_name ? `Change the company name for this ${word}` : `Add a company name for this ${word}`}
                  onClick={() => setNaming('company name')}
                />
              )}
              {companyChanged && <ChangedNote noun="company name" customerValue={customer.company_name?.trim() ?? ''} marker={markers.changed} />}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {phones.map((p) => {
          const changed = changedEntryFor(contactEntries, 'PHONE', p.phone);
          if (changed) return <RecordEntryLine key={p.phone} entry={changed} name={name} context={callContext} record={word} onEdit={entryPencil(changed)} />;
          return (
            <p key={p.phone} className="text-text-secondary flex flex-wrap items-center gap-x-1.5 text-sm">
              <Phone className="size-3.5 shrink-0" aria-hidden />
              <PhoneValue kind="customer_phone" phone={p.phone} extension={p.extension} name={name} context={callContext} />
              {p.label && <span className="text-xs">{p.label}</span>}
              {p.is_primary && phones.length > 1 && <span className="text-xs">Primary</span>}
              {pencil && (
                <PencilButton
                  label={`Change this phone for this ${word}`}
                  onClick={() => setAdding({ kind: 'PHONE', target: { value: p.phone, extension: p.extension, label: p.label } })}
                />
              )}
            </p>
          );
        })}
        {pencil && phones.length === 0 && (
          <p className="text-text-secondary flex flex-wrap items-center gap-x-1.5 text-sm">
            <Phone className="size-3.5 shrink-0" aria-hidden />
            <span>No phone</span>
            <PencilButton label={`Add a phone for this ${word}`} onClick={() => setAdding({ kind: 'PHONE', target: null })} />
          </p>
        )}
        {emails.map((e) => {
          const changed = changedEntryFor(contactEntries, 'EMAIL', e.email);
          if (changed) return <RecordEntryLine key={e.email} entry={changed} name={name} context={callContext} record={word} onEdit={entryPencil(changed)} />;
          return (
            <p key={e.email} className="text-text-secondary flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
              <Mail className="size-3.5 shrink-0" aria-hidden />
              <EmailValue email={e.email} />
              {e.label && <span className="text-xs">{e.label}</span>}
              {pencil && (
                <PencilButton
                  label={`Change this email for this ${word}`}
                  onClick={() => setAdding({ kind: 'EMAIL', target: { value: e.email, label: e.label } })}
                />
              )}
            </p>
          );
        })}
        {pencil && emails.length === 0 && (
          <p className="text-text-secondary flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
            <Mail className="size-3.5 shrink-0" aria-hidden />
            <span>No email</span>
            <PencilButton label={`Add an email for this ${word}`} onClick={() => setAdding({ kind: 'EMAIL', target: null })} />
          </p>
        )}
        {contactEntries
          .filter((entry) => !standsInPlace.has(entry.id))
          .map((entry) => (
            <RecordEntryLine key={entry.id} entry={entry} name={name} context={callContext} record={word} onEdit={entryPencil(entry)} />
          ))}
        {serviceAddress && (
          <p className="text-text-secondary flex items-start gap-1.5 text-sm">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0">{serviceAddress}</span>
          </p>
        )}
        {record?.kind === 'lead' && record.closed && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-text-secondary text-xs">{CLOSED_LEAD_LINE}</p>
            {record.onReopen && (
              <Button type="button" variant="outline" size="sm" onClick={record.onReopen}>
                Reopen lead
              </Button>
            )}
          </div>
        )}
      </div>

      {recordRef && naming && (
        <NameEntryDialog
          open
          onOpenChange={(open) => {
            if (!open) setNaming(null);
          }}
          record={recordRef}
          subject={naming}
          fields={nameFields(naming === 'name' ? ['FIRST_NAME', 'LAST_NAME'] : ['COMPANY_NAME'])}
        />
      )}

      {recordRef && adding && (
        <ContactEntryDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          record={recordRef}
          kind={adding.kind}
          target={adding.target}
          entry={adding.entry}
        />
      )}

      {showActions && (primaryPhone || primaryEmail) && (
        <ContactActions
          policy={policy}
          context={callContext}
          phone={primaryPhone?.phone}
          email={primaryEmail?.email}
        />
      )}

      {/* The customer record's own edit form: beside the job-only pencil, never hidden by a job lock or a closed lead. */}
      {showEditCustomer && (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/customers/${customer.id}/edit`}>
            <Pencil aria-hidden /> Edit customer
          </Link>
        </Button>
      )}
    </div>
  );
}

function PencilButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} className="size-6 shrink-0" onClick={onClick}>
      <Pencil aria-hidden />
    </Button>
  );
}

const entryDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const digitsOf = (phone: string) => phone.replace(/\D/g, '');

/** The live entry that replaces this customer phone or email on the job, if there is one. */
function changedEntryFor(entries: RecordContactEntry[], kind: 'PHONE' | 'EMAIL', customerValue: string) {
  const same = (a: string, b: string) => (kind === 'PHONE' ? digitsOf(a) === digitsOf(b) : a.trim().toLowerCase() === b.trim().toLowerCase());
  return entries.find((e) => e.intent === 'CHANGED' && e.kind === kind && e.customer_value_at_change !== null && same(e.customer_value_at_change, customerValue));
}

/** "Changed on this job" beside a name or company the record holds its own value of, with the customer's one tap away. */
function ChangedNote({ noun, customerValue, marker }: { noun: 'name' | 'company name'; customerValue: string; marker: string }) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <span className="text-xs font-medium">{marker}</span>
      {customerValue && (
        <Button variant="link" size="sm" className="h-auto px-0 text-xs font-normal" onClick={() => setShown((now) => !now)}>
          {shown ? `Hide the customer's ${noun}` : `Show the customer's ${noun}`}
        </Button>
      )}
      {customerValue && shown && (
        <span className="basis-full text-xs">
          Customer record: <span>{customerValue}</span>
        </span>
      )}
    </>
  );
}

/**
 * One of the record's own phones or emails: under the same copy and tap rules as the customer's, marked as this job's
 * (or lead's). One that replaces a customer value is marked "Changed on this job" and shows the customer's value on tap.
 */
function RecordEntryLine({
  entry, name, context, record, onEdit,
}: {
  entry: RecordContactEntry;
  name: string;
  context: DialerEntityContext;
  record: ContactRecordRef['kind'];
  onEdit?: () => void;
}) {
  const [showCustomer, setShowCustomer] = useState(false);
  const changed = entry.intent === 'CHANGED';
  const verb = changed ? 'Changed' : 'Added';
  const author = entry.created_by.name ? `${verb} by ${entry.created_by.name} on ${entryDate(entry.created_at)}` : `${verb} ${entryDate(entry.created_at)}`;
  const isPhone = entry.kind === 'PHONE';
  const customerValue = changed ? entry.customer_value_at_change : null;
  const noun = isPhone ? 'phone' : 'email';
  const markers = entryMarkers(record);
  return (
    <div className="text-text-secondary flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
      {isPhone ? <Phone className="size-3.5 shrink-0" aria-hidden /> : <Mail className="size-3.5 shrink-0" aria-hidden />}
      {isPhone ? (
        <PhoneValue kind="customer_phone" phone={entry.value} extension={entry.extension} name={name} context={context} recordOnly />
      ) : (
        <EmailValue email={entry.value} />
      )}
      {entry.label && <span className="text-xs">{entry.label}</span>}
      <span className="text-xs font-medium">{changed ? markers.changed : markers.only}</span>
      <span className="text-xs">{author}</span>
      {onEdit && <PencilButton label={`Edit or remove this ${noun} for this ${record}`} onClick={onEdit} />}
      {customerValue && (
        <Button variant="link" size="sm" className="h-auto px-0 text-xs font-normal" onClick={() => setShowCustomer((shown) => !shown)}>
          {showCustomer ? `Hide the customer's ${noun}` : `Show the customer's ${noun}`}
        </Button>
      )}
      {customerValue && showCustomer && (
        <span className="flex basis-full min-w-0 flex-wrap items-center gap-x-1.5 pl-5 text-xs">
          Customer record:
          {isPhone ? (
            <PhoneValue kind="customer_phone" phone={customerValue} name={name} context={context} />
          ) : (
            <EmailValue email={customerValue} />
          )}
        </span>
      )}
    </div>
  );
}

function ContactActions({
  policy, context, phone, email,
}: {
  policy: ContactPolicyInput;
  context: DialerEntityContext;
  phone?: string;
  email?: string;
}) {
  const navigate = useNavigate();
  const noticeId = useId();
  const d = phone ? phoneDisplay('customer_phone', phone, null, policy) : null;
  const emailDisplay = email ? customerEmailDisplay(email, policy) : null;

  const call =
    !d || !phone ? null : d.call === 'in_app_dial' ? (
      <Button variant="outline" size="sm" onClick={() => requestCall(phone, callOnly(context))}>
        <Phone aria-hidden /> Call
      </Button>
    ) : d.call === 'native_link' ? (
      <Button variant="outline" size="sm" asChild>
        <ActionLink href={telHref(phone)}>
          <Phone aria-hidden /> Call
        </ActionLink>
      </Button>
    ) : d.call === 'disabled' ? (
      <Button variant="outline" size="sm" disabled aria-describedby={noticeId}>
        <Phone aria-hidden /> Call
      </Button>
    ) : null;

  const text =
    !d || !phone ? null : d.textAction === 'in_app_text' ? (
      <Button variant="outline" size="sm" onClick={() => navigate(textPath(phone, context, { viewCustomers: policy.switches.viewCustomers }))}>
        <MessageSquare aria-hidden /> Text
      </Button>
    ) : d.textAction === 'native_link' ? (
      <Button variant="outline" size="sm" asChild>
        <ActionLink href={smsHref(phone)}>
          <MessageSquare aria-hidden /> Text
        </ActionLink>
      </Button>
    ) : null;

  const mail =
    email && emailDisplay?.tap === 'mail_link' ? (
      <Button variant="outline" size="sm" asChild>
        <ActionLink href={`mailto:${email}`}>
          <Mail aria-hidden /> Email
        </ActionLink>
      </Button>
    ) : null;

  if (!call && !text && !mail) return null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {call}
        {text}
        {mail}
      </div>
      {d?.call === 'disabled' && (
        <p id={noticeId} className="text-text-secondary text-xs">
          {CALL_NOT_SET_UP_MESSAGE}
        </p>
      )}
    </div>
  );
}
