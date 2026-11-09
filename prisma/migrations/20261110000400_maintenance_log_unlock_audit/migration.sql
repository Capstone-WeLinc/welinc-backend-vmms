CREATE TABLE "maintenance_log_edit_unlocks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMPTZ(6),
  CONSTRAINT "maintenance_log_edit_unlocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_log_edit_unlocks_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_log_edit_unlocks_schedule_id_created_at_idx"
ON "maintenance_log_edit_unlocks"("schedule_id", "created_at");

CREATE UNIQUE INDEX "maintenance_log_edit_unlocks_one_active_per_schedule_key"
ON "maintenance_log_edit_unlocks"("schedule_id") WHERE "consumed_at" IS NULL;

CREATE TABLE "maintenance_log_edit_audits" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "schedule_id" UUID NOT NULL,
  "unlock_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "unlock_reason" TEXT NOT NULL,
  "field_name" VARCHAR(80) NOT NULL,
  "previous_value" TEXT,
  "new_value" TEXT,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_log_edit_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_log_edit_audits_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_log_edit_audits_unlock_id_fkey"
    FOREIGN KEY ("unlock_id") REFERENCES "maintenance_log_edit_unlocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_log_edit_audits_schedule_id_changed_at_idx"
ON "maintenance_log_edit_audits"("schedule_id", "changed_at");

CREATE INDEX "maintenance_log_edit_audits_actor_id_changed_at_idx"
ON "maintenance_log_edit_audits"("actor_id", "changed_at");
