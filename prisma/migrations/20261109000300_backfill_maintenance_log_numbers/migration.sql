WITH current_sequence AS (
  SELECT COALESCE(MAX(SPLIT_PART("log_number", '-', 3)::BIGINT), 0) AS last_number
  FROM "maintenance_schedules"
  WHERE "log_number" ~ '^MLG-[0-9]{8}-[0-9]+$'
), eligible_schedules AS (
  SELECT
    schedule."id",
    schedule."created_at",
    current_sequence.last_number + ROW_NUMBER() OVER (ORDER BY schedule."created_at", schedule."id") AS sequence_number
  FROM "maintenance_schedules" AS schedule
  CROSS JOIN current_sequence
  WHERE schedule."status" IN ('DONE', 'COMPLETED')
    AND schedule."log_number" IS NULL
)
UPDATE "maintenance_schedules" AS schedule
SET "log_number" =
  'MLG-' || TO_CHAR(eligible_schedules."created_at" AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') ||
  '-' || LPAD(eligible_schedules.sequence_number::TEXT, GREATEST(4, LENGTH(eligible_schedules.sequence_number::TEXT)), '0')
FROM eligible_schedules
WHERE schedule."id" = eligible_schedules."id";

SELECT SETVAL(
  'maintenance_log_number_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(SPLIT_PART("log_number", '-', 3)::BIGINT)
      FROM "maintenance_schedules"
      WHERE "log_number" ~ '^MLG-[0-9]{8}-[0-9]+$'
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "maintenance_schedules" WHERE "log_number" ~ '^MLG-[0-9]{8}-[0-9]+$')
);
