CREATE SEQUENCE "maintenance_schedule_work_order_number_seq";

ALTER TABLE "maintenance_schedules"
ADD COLUMN "work_order_number" VARCHAR(32);

WITH numbered_schedules AS (
  SELECT
    "id",
    "created_at",
    ROW_NUMBER() OVER (ORDER BY "created_at", "id") AS sequence_number
  FROM "maintenance_schedules"
)
UPDATE "maintenance_schedules" AS schedule
SET "work_order_number" =
  'WO-' || TO_CHAR(numbered_schedules."created_at" AT TIME ZONE 'UTC', 'YYYYMMDD') ||
  '-' || LPAD(numbered_schedules.sequence_number::TEXT, 6, '0')
FROM numbered_schedules
WHERE schedule."id" = numbered_schedules."id";

SELECT SETVAL(
  'maintenance_schedule_work_order_number_seq',
  (SELECT COUNT(*) + 1 FROM "maintenance_schedules"),
  FALSE
);

ALTER TABLE "maintenance_schedules"
ALTER COLUMN "work_order_number" SET NOT NULL,
ALTER COLUMN "work_order_number" SET DEFAULT (
  'WO-' || TO_CHAR(CURRENT_DATE, 'YYYYMMDD') || '-' ||
  LPAD(NEXTVAL('maintenance_schedule_work_order_number_seq')::TEXT, 6, '0')
);

CREATE UNIQUE INDEX "maintenance_schedules_work_order_number_key"
ON "maintenance_schedules"("work_order_number");
