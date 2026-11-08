-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AttachmentContext" ADD VALUE 'BEFORE_PHOTO';
ALTER TYPE "AttachmentContext" ADD VALUE 'DURING_PHOTO';
ALTER TYPE "AttachmentContext" ADD VALUE 'AFTER_PHOTO';
ALTER TYPE "AttachmentContext" ADD VALUE 'ISSUE_PHOTO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobStatus" ADD VALUE 'EN_ROUTE';
ALTER TYPE "JobStatus" ADD VALUE 'ON_SITE';

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "en_route_at" TIMESTAMP(3),
ADD COLUMN     "on_site_at" TIMESTAMP(3),
ADD COLUMN     "signature_at" TIMESTAMP(3),
ADD COLUMN     "signature_data" TEXT,
ADD COLUMN     "signature_ip" TEXT;
