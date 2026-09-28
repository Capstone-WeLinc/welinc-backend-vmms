CREATE TABLE "maintenance_schedule_cancellations" (
  "id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "reason" TEXT NOT NULL CHECK (length(btrim("reason")) > 0),
  "previous_status" "MaintenanceStatus" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_schedule_cancellations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_schedule_cancellations_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "maintenance_schedule_cancellations_schedule_id_created_at_idx"
  ON "maintenance_schedule_cancellations"("schedule_id", "created_at");

-- Preserve the audit from the previously approved one-time duplicate cleanup.
-- Keep its original timestamp and identity; retain the original JSON as well.
INSERT INTO "maintenance_schedule_cancellations"
  (id, schedule_id, actor_id, actor_name, actor_email, reason, previous_status, created_at)
SELECT gen_random_uuid(), s.id, (entry->>'approvedByUserId')::uuid,
  entry->>'approvedByName', entry->>'approvedByEmail', entry->>'reason',
  (entry->>'previousStatus')::"MaintenanceStatus", (entry->>'timestamp')::timestamptz
FROM maintenance_schedules s
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(s.work_order_progress->'auditTrail') = 'array'
    THEN s.work_order_progress->'auditTrail' ELSE '[]'::jsonb END
) AS entry
WHERE entry->>'source' = 'User-approved data repair executed by Codex'
  AND entry->>'action' = 'CANCEL';
