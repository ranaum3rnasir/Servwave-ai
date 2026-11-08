-- §3.5b Polymorphic TagAssignment — generic shared tag store for LEAD + JOB
-- LeadTag table retained (read-only legacy) until a later cleanup migration.

-- 1. Enum
CREATE TYPE "TagEntity" AS ENUM ('LEAD', 'JOB');

-- 2. Table
CREATE TABLE "tag_assignments" (
    "tag_id" UUID NOT NULL,
    "entity_type" "TagEntity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "tag_assignments_pkey" PRIMARY KEY ("tag_id", "entity_type", "entity_id")
);

-- 3. Indexes
CREATE INDEX "tag_assignments_entity_type_entity_id_idx"
    ON "tag_assignments" ("entity_type", "entity_id");

CREATE INDEX "tag_assignments_organization_id_idx"
    ON "tag_assignments" ("organization_id");

-- 4. Foreign keys
ALTER TABLE "tag_assignments"
    ADD CONSTRAINT "tag_assignments_tag_id_fkey"
    FOREIGN KEY ("tag_id") REFERENCES "tags"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "tag_assignments"
    ADD CONSTRAINT "tag_assignments_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- 5. Backfill from legacy lead_tags (denormalize org_id off the tag row)
INSERT INTO "tag_assignments" ("tag_id", "entity_type", "entity_id", "created_at", "organization_id")
SELECT lt.tag_id, 'LEAD'::"TagEntity", lt.lead_id, NOW(), t.organization_id
FROM "lead_tags" lt
JOIN "tags" t ON t.id = lt.tag_id
ON CONFLICT DO NOTHING;
