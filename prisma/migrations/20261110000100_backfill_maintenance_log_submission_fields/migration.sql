UPDATE "maintenance_schedules" AS schedule
SET "work_order_progress" =
  COALESCE(schedule."work_order_progress", '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
    'maintenanceClass', CASE
      WHEN schedule."title" ~* '(repair|replace|replacement|clutch|brake pad|leak|failure)' THEN 'REPAIR'
      ELSE 'PREVENTIVE'
    END,
    'maintenanceRemarks', COALESCE(
      NULLIF(schedule."work_order_progress"->>'maintenanceRemarks', ''),
      'Legacy sample maintenance record; original work description was not recorded.'
    ),
    'serviceOdometerReading', schedule."odometer_reading",
    'laborCost', schedule."labor_cost"
  ))
WHERE schedule."status" = 'COMPLETED'
  AND jsonb_typeof(COALESCE(schedule."work_order_progress", '{}'::jsonb)) = 'object';
