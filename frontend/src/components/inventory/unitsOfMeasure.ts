/**
 * Units of measure - a FIXED list, deliberately not user-extendable, and
 * deliberately short.
 *
 * This replaced a per-org `uom_options` table with add/edit/delete. Ran's call
 * (2026-08-12): a unit is not per-business vocabulary the way a brand or a
 * finish is, and letting each org invent its own produced exactly the mess you
 * would expect - the demo org ended up with both BX and BOX meaning "box",
 * indistinguishable in the dropdown. A 21-entry catalogue was drafted first and
 * cut to these six, also Ran's call: a list you scroll is a list you misread.
 *
 * WHERE THE CODES COME FROM. The brief was "use Zoho's list". Zoho does not
 * have one: its unit field is a free-text typeahead and the Inventory API
 * documents `unit` as an arbitrary string. No comparable product ships a fixed
 * list either - ServiceTitan, Housecall Pro, Sage and Zoho are all free text or
 * user-defined; Jobber and Xero have no unit field at all. So the spellings
 * here follow ANSI X12 element 355 (what US distributors actually transmit)
 * where it is unambiguous - EA, FT, IN, LB - and the readable form otherwise.
 * X12 would write GA for gallon and MR for meter; GAL and MTR read better and
 * nothing downstream parses these. MTR rather than a bare M on purpose: in wire
 * and pipe pricing M means one thousand (MFT = 1,000 feet), so M for metre
 * would be a genuine misread.
 *
 * These are DISPLAY codes. If ServWave ever speaks EDI or punchout for real
 * that needs its own interop column - X12 and UN/CEFACT Rec 20 disagree
 * outright on several codes, so a bare code means nothing without the standard
 * it came from.
 *
 * CODES ARE LOAD-BEARING AND MUST NOT BE RENAMED. An item stores this CODE
 * STRING, not a foreign key, and the same string already rides on PO lines,
 * stock movements, job stage lines and reservation lines. Renaming FT to FOOT
 * orphans every item carrying FT.
 *
 * KNOWN ORPHANS, accepted with the cut to six (measured 2026-08-12). Prod holds
 * 601 items, every one of them EA, so prod is untouched. Staging holds five
 * items on codes that are no longer offered - one each of KIT, BOX, ROLL, CYL
 * and HR. Those items still DISPLAY their stored code (AddItemDialog appends an
 * unrecognised value to the options so the trigger never blanks), but the code
 * cannot be picked again once changed. That is the intended trade.
 */
export type UnitOfMeasure = { code: string; label: string };

export const UNITS_OF_MEASURE: UnitOfMeasure[] = [
  { code: "EA", label: "Each" },
  { code: "FT", label: "Foot" },
  { code: "IN", label: "Inch" },
  { code: "GAL", label: "Gallon" },
  { code: "LB", label: "Pound" },
  { code: "MTR", label: "Meter" },
];

/** Dropdown options: the code leads, since that is what a table cell shows. */
export const UOM_SELECT_OPTIONS = UNITS_OF_MEASURE.map((u) => ({
  value: u.code,
  label: `${u.code} · ${u.label}`,
}));
