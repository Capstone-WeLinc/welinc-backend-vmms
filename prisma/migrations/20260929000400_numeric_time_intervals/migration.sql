ALTER TABLE maintenance_schedules
  ADD COLUMN time_interval_value INTEGER,
  ADD COLUMN time_interval_unit VARCHAR(6);
-- Translate existing presets without changing their cadence. Unspecified time
-- intervals use the documented three-month default; reference dates are retained.
UPDATE maintenance_schedules SET
  time_interval_value = CASE interval_type
    WHEN 'DAILY' THEN 1 WHEN 'WEEKLY' THEN 7 WHEN 'MONTHLY' THEN 1
    WHEN 'SEMI_ANNUALLY' THEN 6 WHEN 'ANNUALLY' THEN 12 ELSE 3 END,
  time_interval_unit = CASE WHEN interval_type IN ('DAILY','WEEKLY') THEN 'DAYS' ELSE 'MONTHS' END
WHERE trigger_type = 'TIME';
ALTER TABLE maintenance_schedules ADD CONSTRAINT maintenance_time_interval_valid CHECK (
  (time_interval_value IS NULL AND time_interval_unit IS NULL) OR
  (time_interval_value IS NOT NULL AND time_interval_unit IS NOT NULL AND
   time_interval_value > 0 AND time_interval_unit IN ('DAYS', 'MONTHS'))
);
