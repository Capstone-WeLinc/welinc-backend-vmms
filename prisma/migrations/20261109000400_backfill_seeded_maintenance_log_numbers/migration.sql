WITH eligible_schedules AS (
  SELECT
    "id",
    "created_at",
    NEXTVAL('maintenance_log_number_seq') AS sequence_number
  FROM "maintenance_schedules"
  WHERE "status" IN ('DONE', 'COMPLETED')
    AND "log_number" IS NULL
)
UPDATE "maintenance_schedules" AS schedule
SET "log_number" =
  'MLG-' || TO_CHAR(eligible_schedules."created_at" AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') ||
  '-' || LPAD(eligible_schedules.sequence_number::TEXT, GREATEST(4, LENGTH(eligible_schedules.sequence_number::TEXT)), '0')
FROM eligible_schedules
WHERE schedule."id" = eligible_schedules."id";
