WITH mechanic_matches AS (
  SELECT
    schedule.id AS schedule_id,
    MIN(mechanic.id::text)::uuid AS mechanic_id
  FROM maintenance_schedules AS schedule
  JOIN users AS mechanic
    ON LOWER(TRIM(mechanic.name)) = LOWER(TRIM(schedule.assigned_mechanic))
   AND mechanic.is_active = TRUE
   AND mechanic.deleted_at IS NULL
  JOIN user_roles AS role_assignment
    ON role_assignment.user_id = mechanic.id
   AND role_assignment.role = 'MECHANIC'
   AND role_assignment.system = 'VMMS'
  WHERE schedule.assigned_mechanic_id IS NULL
  GROUP BY schedule.id
  HAVING COUNT(DISTINCT mechanic.id) = 1
)
UPDATE maintenance_schedules AS schedule
SET assigned_mechanic_id = mechanic_matches.mechanic_id
FROM mechanic_matches
WHERE schedule.id = mechanic_matches.schedule_id;