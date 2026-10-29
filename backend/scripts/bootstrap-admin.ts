#!/usr/bin/env npx tsx
/**
 * Create the FIRST admin of a freshly-provisioned org.
 *
 * Runs against whatever Supabase the process env points at:
 *   staging rehearsal:
 *     npx tsx backend/scripts/bootstrap-admin.ts --org-id <uuid> --email admin@org.com --first Jane --last Doe
 *   prod (operator supplies prod creds — the worktree .env is staging):
 *     SUPABASE_URL=<prod> SUPABASE_SERVICE_ROLE_KEY=<prod> DATABASE_URL=<prod> \
 *       npx tsx backend/scripts/bootstrap-admin.ts --org-id <uuid> --email admin@org.com --first Jane --last Doe
 *
 * Uses the Supabase Auth admin API (NOT MCP — auth users are not SQL-manageable)
 * plus the same invite dispatch as user.controller.ts create + dispatchInvite. The
 * ONLY email onboarding ever sends is this admin's own set-password invite; the
 * admin then adds the rest of the team through the app.
 */
import { Role } from '@prisma/client';
import { supabaseAdmin } from '../src/lib/supabase';
import { prisma } from '../src/lib/prisma';
import { runUnscoped } from '../src/lib/tenant-context';
import { signInviteToken } from '../src/lib/invite-token';
import { sendUserInviteEmail } from '../src/lib/email';
import { env } from '../src/config/env';

const args = process.argv.slice(2);
const arg = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

async function main() {
  const orgId = arg('--org-id');
  const email = arg('--email');
  const first = arg('--first');
  const last = arg('--last') ?? '';
  if (!orgId || !email || !first) {
    console.error('Required: --org-id <uuid> --email <admin email> --first <name> [--last <name>]');
    process.exit(1);
  }

  await runUnscoped(async () => {
    // Confirm the org exists (and surface its name) before creating any auth identity.
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { id: true, name: true },
    });

    // Guard: refuse if this org already has any login-enabled user — "first admin"
    // means first. Re-running should not mint a second admin.
    const existingLogin = await prisma.user.findFirst({
      where: { organization_id: orgId, has_login: true },
      select: { email: true },
    });
    if (existingLogin) {
      console.error(`Org already has a login-enabled user (${existingLogin.email}). Refusing to create a second admin.`);
      process.exit(1);
    }

    // Create in Supabase Auth first (mirrors user.controller.ts:171).
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (authError || !authData.user) {
      const msg = authError?.message ?? 'unknown error';
      // A leftover auth user from a prior run that died before the Prisma row would
      // pass the has_login guard above but fail here on the duplicate email.
      if (/already.*(registered|exists)/i.test(msg) || (authError as { code?: string } | null)?.code === 'email_exists') {
        console.error(
          `Auth user for ${email} already exists but has no app account — a prior run likely died mid-way. ` +
          `Delete that Supabase Auth user (or finish its Prisma row manually), then re-run.`,
        );
      } else {
        console.error(`Auth createUser failed: ${msg}`);
      }
      process.exit(1);
    }

    try {
      const user = await prisma.user.create({
        data: {
          id: authData.user.id,
          email,
          first_name: first,
          last_name: last,
          role: Role.ADMIN,
          organization_id: orgId,
          has_login: true,
        },
        select: { id: true, email: true, first_name: true, organization_id: true },
      });

      // Dispatch the branded set-password invite (mirrors dispatchInvite).
      const token = signInviteToken(user.id, user.email);
      const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
      const emailSent = await sendUserInviteEmail({
        to: user.email,
        firstName: user.first_name,
        inviteUrl,
        organizationId: user.organization_id,
      });

      console.log(`\n✅ First admin created for ${org.name}`);
      console.log(`   Email:       ${user.email} (ADMIN, has_login)`);
      console.log(`   Invite sent: ${emailSent ? 'yes' : 'NO — send the URL below manually'}`);
      console.log(`   Invite URL:  ${inviteUrl}`);
      console.log(`\n   The admin sets their password via that link, then adds the rest of the team in-app.\n`);
    } catch (prismaError) {
      // Rollback the auth user if the Prisma row fails (mirrors user.controller.ts:209).
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      console.error('Prisma user.create failed (rolled back the auth user):', prismaError);
      process.exit(1);
    }
  });
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
