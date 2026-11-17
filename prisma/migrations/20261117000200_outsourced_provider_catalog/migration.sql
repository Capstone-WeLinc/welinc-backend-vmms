CREATE TABLE "outsourced_providers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(150) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "outsourced_providers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outsourced_providers_name_key" ON "outsourced_providers"("name");
CREATE INDEX "outsourced_providers_is_active_name_idx" ON "outsourced_providers"("is_active", "name");

ALTER TABLE "maintenance_schedules" ADD COLUMN "outsourced_provider" VARCHAR(150);
