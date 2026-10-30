import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { buildCatalogLayout } from '../lib/permissions/switches/layout';
import { isPersonSetting } from '../lib/permissions/switches/settings';
import { effectiveAcceptedMethods } from '../lib/permissions/paymentMethods';
import { isSuperUser } from '../lib/permissions/effectiveRole';
import { resolveSwitches } from '../lib/permissions/switches/store';
import { computeSwitchesStamp } from '../lib/permissions/switches/stamp';

/**
 * GET /api/permission-switches/catalog - the switch catalog (Roles & Permissions M1).
 *
 * Open to any signed-in person: the catalog says what switches exist and what each preset holds, and
 * holds nothing about any person or company. What the server enforces from (`grants`, `serverChecks`)
 * stays server-side.
 */
export function getCatalog(_req: Request, res: Response) {
  res.json({
    switches: SWITCH_CATALOG.map((s) => ({
      key: s.key,
      module: s.module,
      label: s.label,
      helpText: s.helpText,
      kind: s.kind,
      // A choice switch's selectable options. A kept value (stored and honoured, never offered) is not listed.
      choices: s.choices,
      // A list switch's members: the options a fixed subset may hold.
      listOptions: s.listOptions,
      // The plain name and meaning of a kept value, so a screen can show it read-only beside the real choices.
      keptValueHelp: s.keptValueHelp,
      requires: s.requires,
      requiresAny: s.requiresAny,
      presets: s.presets,
      // A per-person setting (P1): edited on the person's profile, not on the Permissions screens.
      setting: isPersonSetting(s.key),
    })),
    // Where each switch sits on the Roles and Permissions screens: groups, rows, first line and nesting.
    layout: buildCatalogLayout(SWITCH_CATALOG),
  });
}

/**
 * GET /api/permission-switches/accepted-payment-methods - the signed-in person's company's effective accepted payment
 * methods (the methods ticked in ServWave Payments plus Credit Card while the card processor is live, or every method
 * when none is ticked). What the Allowed payment methods editor offers and the payment dialogs filter by. Open to any
 * signed-in person of that company: it is the list the payment server check itself reads.
 */
export async function getAcceptedPaymentMethods(req: Request, res: Response) {
  const org = await prisma.organization.findUnique({
    where: { id: req.user!.organization_id },
    select: { accepted_payment_methods: true, stripe_charges_enabled: true },
  });
  const { everyMethod, methods } = effectiveAcceptedMethods(org ?? { accepted_payment_methods: [] });
  res.json({ every_method: everyMethod, methods });
}

/**
 * GET /api/permission-switches/me - the signed-in person's resolved value for every switch (Show, Access and list
 * values included) and the rules those values compile into, so the client can draw menus and buttons. The client only
 * draws from this; the server decides access on every request. Open to any signed-in person: it is their own.
 */
export async function getMe(req: Request, res: Response) {
  const [values, switches_version] = await Promise.all([
    resolveSwitches(req.user!),
    computeSwitchesStamp(req.user!).catch(() => null),
  ]);
  res.json({ admin_box: isSuperUser(req.user!), values, rules: req.ability!.rules, switches_version });
}
