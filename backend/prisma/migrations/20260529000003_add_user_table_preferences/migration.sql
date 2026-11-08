-- CreateTable
CREATE TABLE "user_table_preferences" (
    "user_id" UUID NOT NULL,
    "table_key" VARCHAR(40) NOT NULL,
    "config" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_table_preferences_pkey" PRIMARY KEY ("user_id","table_key")
);

-- CreateIndex
CREATE INDEX "user_table_preferences_user_id_idx" ON "user_table_preferences"("user_id");

-- AddForeignKey
ALTER TABLE "user_table_preferences" ADD CONSTRAINT "user_table_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
