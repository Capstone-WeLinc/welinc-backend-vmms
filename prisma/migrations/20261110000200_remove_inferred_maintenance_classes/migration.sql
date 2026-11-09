UPDATE "maintenance_schedules" AS schedule
SET "work_order_progress" = jsonb_set(
  COALESCE(schedule."work_order_progress", '{}'::jsonb),
  '{maintenanceClass}',
  '"UNCLASSIFIED"'::jsonb,
  TRUE
)
WHERE schedule."status" = 'COMPLETED'
  AND jsonb_typeof(COALESCE(schedule."work_order_progress", '{}'::jsonb)) = 'object';
