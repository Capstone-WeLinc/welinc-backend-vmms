ALTER TABLE "maintenance_schedules" ADD COLUMN "assigned_mechanic_id" UUID;
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_assigned_mechanic_id_fkey" FOREIGN KEY ("assigned_mechanic_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "maintenance_schedules_assigned_mechanic_id_idx" ON "maintenance_schedules"("assigned_mechanic_id");

-- Fail closed for ambiguous legacy names: Operations must assign an explicit user ID.
UPDATE "maintenance_schedules" s SET "assigned_mechanic_id" = candidates.id
FROM (
  SELECT lower(trim(u.name)) AS name, min(u.id::text)::uuid AS id
  FROM users u WHERE u.deleted_at IS NULL AND u.is_active = true
  AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.system = 'VMMS' AND r.role = 'MECHANIC')
  GROUP BY lower(trim(u.name)) HAVING count(*) = 1
) candidates WHERE lower(trim(s.assigned_mechanic)) = candidates.name AND s.account_type IS DISTINCT FROM 'OUTSOURCED';

CREATE TABLE "maintenance_notifications" (
  "id" UUID NOT NULL PRIMARY KEY,
  "user_id" UUID NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "schedule_id" UUID NOT NULL REFERENCES "maintenance_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" VARCHAR(20) NOT NULL,
  "message" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "read_at" TIMESTAMPTZ(6),
  "sms_status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "sms_provider_id" VARCHAR(100)
);
CREATE UNIQUE INDEX "maintenance_notifications_user_id_schedule_id_kind_key" ON "maintenance_notifications"("user_id", "schedule_id", "kind");
CREATE INDEX "maintenance_notifications_user_id_created_at_idx" ON "maintenance_notifications"("user_id", "created_at");
