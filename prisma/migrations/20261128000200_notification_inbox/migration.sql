ALTER TABLE "notifications"
ADD COLUMN "category" VARCHAR(30) NOT NULL DEFAULT 'GENERAL',
ADD COLUMN "action_type" VARCHAR(40),
ADD COLUMN "action_target_id" UUID;

UPDATE "notifications"
SET
  "category" = CASE
    WHEN "title" ILIKE '%fuel%anomaly%' OR "title" ILIKE '%anomaly%fuel%' THEN 'FUEL'
    WHEN "title" ILIKE '%fleet%report%' THEN 'REPORT'
    WHEN "title" ILIKE '%maintenance%' THEN 'MAINTENANCE'
    ELSE 'GENERAL'
  END,
  "action_type" = CASE
    WHEN "maintenance_schedule_id" IS NOT NULL THEN 'MAINTENANCE_SCHEDULE'
    WHEN "title" ILIKE '%fuel%anomaly%' OR "title" ILIKE '%anomaly%fuel%' THEN 'FUEL_MANAGEMENT'
    WHEN "title" ILIKE '%fleet%report%' THEN 'REPORTS'
    ELSE NULL
  END,
  "action_target_id" = "maintenance_schedule_id";

CREATE INDEX "notifications_user_id_category_is_read_created_at_idx"
ON "notifications"("user_id", "category", "is_read", "created_at" DESC);
