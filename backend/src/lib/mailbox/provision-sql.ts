/**
 * The mailbox address register's rules as one idempotent SQL statement, for provisioning a company by
 * hand (the onboarding batch lib/entitlements/ops-sql.ts builds, which is applied as raw SQL and so
 * cannot call register.ts). Same rules, same lock: freeze the company part (the name's own, else the
 * next free variant, else a generated neutral one), create the main mailbox and issue its address. A
 * company that already has a main mailbox is left alone, so applying the batch twice changes nothing.
 *
 * Kept free of blank lines: the batch is split into statements on a blank line.
 */
export function issueMainMailboxSql(orgIdLiteral: string): string {
  return [
    `DO $$`,
    `DECLARE`,
    `  org uuid := ${orgIdLiteral}::uuid;`,
    `  reserved text[] := ARRAY['postmaster', 'abuse', 'bounce', 'bounces', 'no-reply', 'noreply'];`,
    `  stem text;`,
    `  n integer;`,
    `  candidate text;`,
    `  box uuid;`,
    `BEGIN`,
    `  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox_address_register', 0));`,
    `  IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = org)`,
    `     OR EXISTS (SELECT 1 FROM "mailboxes" WHERE "organization_id" = org AND "kind" = 'main') THEN`,
    `    RETURN;`,
    `  END IF;`,
    `  SELECT coalesce(NULLIF(lower(btrim("email_sender_local_part")), ''), left(regexp_replace(lower("name"), '[^a-z0-9]', '', 'g'), 40))`,
    `    INTO stem FROM "organizations" WHERE "id" = org;`,
    `  IF coalesce(stem, '') = '' OR stem = ANY (reserved) THEN`,
    `    stem := 'company';`,
    `    n := 1;`,
    `  ELSE`,
    `    n := 0;`,
    `  END IF;`,
    `  LOOP`,
    `    IF n = 0 THEN candidate := stem; ELSE candidate := left(stem, 40 - length(n::text)) || n::text; END IF;`,
    `    EXIT WHEN NOT (candidate = ANY (reserved))`,
    `      AND NOT EXISTS (SELECT 1 FROM "mailbox_addresses" a WHERE a."local_part" = candidate)`,
    `      AND NOT EXISTS (`,
    `        SELECT 1 FROM "organizations" o`,
    `        WHERE o."id" <> org`,
    `          AND (lower(btrim(o."email_sender_local_part")) = candidate`,
    `               OR (o."email_sender_local_part" IS NULL AND left(regexp_replace(lower(o."name"), '[^a-z0-9]', '', 'g'), 40) = candidate))`,
    `      );`,
    `    n := CASE WHEN n = 0 THEN 2 ELSE n + 1 END;`,
    `  END LOOP;`,
    `  UPDATE "organizations" SET "email_sender_local_part" = candidate WHERE "id" = org;`,
    `  box := gen_random_uuid();`,
    `  INSERT INTO "mailboxes" ("id", "organization_id", "kind", "status", "created_at", "updated_at")`,
    `    VALUES (box, org, 'main', 'active', now(), now());`,
    `  INSERT INTO "mailbox_addresses" ("id", "local_part", "kind", "organization_id", "mailbox_id", "is_primary", "issued_at")`,
    `    VALUES (gen_random_uuid(), candidate, 'issued', org, box, true, now());`,
    `END $$;`,
  ].join('\n');
}
