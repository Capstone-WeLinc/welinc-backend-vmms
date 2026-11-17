ALTER TABLE "notifications"
  ADD COLUMN "dedupe_key" VARCHAR(255),
  ADD COLUMN "maintenance_schedule_id" UUID;

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_maintenance_schedule_id_fkey"
  FOREIGN KEY ("maintenance_schedule_id") REFERENCES "maintenance_schedules"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "notifications_dedupe_key_key"
  ON "notifications"("dedupe_key");

CREATE TABLE "scheduled_fleet_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "report_type" VARCHAR(20) NOT NULL,
  "period_key" VARCHAR(10) NOT NULL,
  "data" JSONB NOT NULL,
  "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "scheduled_fleet_reports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduled_fleet_reports_report_type_period_key_key"
  ON "scheduled_fleet_reports"("report_type", "period_key");

