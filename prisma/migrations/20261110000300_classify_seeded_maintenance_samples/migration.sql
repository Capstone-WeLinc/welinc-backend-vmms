-- The current database is populated only by the project's demonstration seeder.
-- This migration classifies those legacy samples explicitly; runtime submissions
-- still require a user to choose Repair or Preventive.
UPDATE "maintenance_schedules" AS schedule
SET "work_order_progress" = jsonb_set(
  COALESCE(schedule."work_order_progress", '{}'::jsonb),
  '{maintenanceClass}',
  CASE
    WHEN schedule."title" IN ('Front & Rear Brake Pad Replacement', 'Clutch Master & Slave Cylinder Service')
      THEN '"REPAIR"'::jsonb
    ELSE '"PREVENTIVE"'::jsonb
  END,
  TRUE
)
WHERE schedule."status" = 'COMPLETED'
  AND schedule."work_order_progress"->>'maintenanceClass' = 'UNCLASSIFIED'
  AND jsonb_typeof(COALESCE(schedule."work_order_progress", '{}'::jsonb)) = 'object';
