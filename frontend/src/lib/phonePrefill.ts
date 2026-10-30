/**
 * `?phone=` arrives E.164 from the Texts inbox and the dialer's create buttons ("Create lead", "Create job") - strip
 * a US country code so the form's masked phone box shows the ten digits. Shared by the lead and job forms.
 */
export function phoneParamDigits(raw: string): string {
  const d = raw.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}
