-- Legacy rows have no reliable start date. Preserve unknown dates as NULL;
-- the API requires an explicit date for new schedules and legacy schedule edits.
ALTER TABLE "maintenance_schedules" ADD COLUMN "start_date" DATE;
