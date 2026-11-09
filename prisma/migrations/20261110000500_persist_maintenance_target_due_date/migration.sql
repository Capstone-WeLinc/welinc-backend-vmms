ALTER TABLE "maintenance_schedules"
ADD COLUMN "target_due_date" DATE;

UPDATE "maintenance_schedules"
SET "target_due_date" = CASE
  WHEN "trigger_type" = 'TIME' AND "start_reference_date" IS NOT NULL THEN
    (("start_reference_date" AT TIME ZONE 'Asia/Manila')::date + (
      COALESCE("time_interval_value", CASE "interval_type"::text
        WHEN 'DAILY' THEN 1 WHEN 'WEEKLY' THEN 7 WHEN 'MONTHLY' THEN 1
        WHEN 'QUARTERLY' THEN 3 WHEN 'SEMI_ANNUALLY' THEN 6 WHEN 'ANNUALLY' THEN 12
        ELSE NULL END
      )::TEXT || ' ' || COALESCE("time_interval_unit", CASE "interval_type"::text
        WHEN 'DAILY' THEN 'DAYS' WHEN 'WEEKLY' THEN 'DAYS' WHEN 'MONTHLY' THEN 'MONTHS'
        WHEN 'QUARTERLY' THEN 'MONTHS' WHEN 'SEMI_ANNUALLY' THEN 'MONTHS' WHEN 'ANNUALLY' THEN 'MONTHS'
        ELSE NULL END)
    )::INTERVAL)::DATE
  ELSE COALESCE("start_date", "created_at"::date) + 30
END
WHERE "target_due_date" IS NULL;
