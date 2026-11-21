CREATE TABLE "fuel_import_drafts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_auth_user_id" VARCHAR(255) NOT NULL,
  "source_name" VARCHAR(255) NOT NULL,
  "rows" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_import_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fuel_import_drafts_owner_auth_user_id_updated_at_idx"
  ON "fuel_import_drafts"("owner_auth_user_id", "updated_at");
