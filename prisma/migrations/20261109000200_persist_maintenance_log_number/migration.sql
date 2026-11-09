CREATE SEQUENCE "maintenance_log_number_seq";

ALTER TABLE "maintenance_schedules"
ADD COLUMN "log_number" VARCHAR(32);

WITH eligible_schedules AS (
  SELECT
    "id",
    "created_at",
    ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS sequence_number
  FROM "maintenance_schedules"
  WHERE "status" IN ('DONE', 'COMPLETED')
)
UPDATE "maintenance_schedules" AS schedule
SET "log_number" =
  'MLG-' || TO_CHAR(eligible_schedules."created_at" AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') ||
  '-' || LPAD(eligible_schedules.sequence_number::TEXT, GREATEST(4, LENGTH(eligible_schedules.sequence_number::TEXT)), '0')
FROM eligible_schedules
WHERE schedule."id" = eligible_schedules."id";

SELECT SETVAL(
  'maintenance_log_number_seq',
  GREATEST((SELECT COUNT(*) FROM "maintenance_schedules" WHERE "log_number" IS NOT NULL), 1),
  EXISTS (SELECT 1 FROM "maintenance_schedules" WHERE "log_number" IS NOT NULL)
);

CREATE UNIQUE INDEX "maintenance_schedules_log_number_key"
ON "maintenance_schedules"("log_number");
