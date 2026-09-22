-- Older mobile versions stored the inspector only in work_order_progress.
UPDATE maintenance_schedules s SET chief_mechanic_id = candidates.id, chief_mechanic = candidates.display_name
FROM (
  SELECT lower(trim(u.name)) AS name, min(u.id::text)::uuid AS id, min(u.name) AS display_name
  FROM users u WHERE u.deleted_at IS NULL AND u.is_active = true
  AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.system = 'VMMS' AND r.role = 'CHIEF_MECHANIC')
  GROUP BY lower(trim(u.name)) HAVING count(*) = 1
) candidates
WHERE s.chief_mechanic_id IS NULL
AND lower(trim(coalesce(nullif(s.work_order_progress->>'chiefMechanic', ''), s.chief_mechanic))) = candidates.name;
