CREATE TYPE "MaintenanceScheduleExtensionReviewStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "MaintenanceScheduleExtensionAuditEventType" AS ENUM (
  'REQUESTED',
  'APPROVED',
  'REJECTED'
);

CREATE TYPE "MaintenanceScheduleRescheduleSource" AS ENUM (
  'MANUAL_UPDATE',
  'EXTENSION_APPROVAL'
);

CREATE TABLE "maintenance_schedule_extensions" (
  "id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "requested_due_date" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  "review_status" "MaintenanceScheduleExtensionReviewStatus" NOT NULL DEFAULT 'PENDING',
  "reviewed_by_id" UUID,
  "reviewed_by_name" VARCHAR(100),
  "reviewed_by_email" VARCHAR(255),
  "review_reason" TEXT,
  "reviewed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_schedule_extensions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_schedule_extensions_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_schedule_extensions_schedule_id_created_at_idx"
  ON "maintenance_schedule_extensions"("schedule_id", "created_at");

CREATE INDEX "maintenance_schedule_extensions_review_status_created_at_idx"
  ON "maintenance_schedule_extensions"("review_status", "created_at");

CREATE INDEX "maintenance_schedule_extensions_reviewed_by_id_reviewed_at_idx"
  ON "maintenance_schedule_extensions"("reviewed_by_id", "reviewed_at");

CREATE UNIQUE INDEX "maintenance_schedule_extensions_one_pending_per_schedule_idx"
  ON "maintenance_schedule_extensions"("schedule_id")
  WHERE "review_status" = 'PENDING';

CREATE TABLE "maintenance_schedule_extension_audits" (
  "id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "extension_id" UUID NOT NULL,
  "event_type" "MaintenanceScheduleExtensionAuditEventType" NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "previous_due_date" DATE,
  "requested_due_date" DATE NOT NULL,
  "reason" TEXT,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_schedule_extension_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_schedule_extension_audits_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_schedule_extension_audits_extension_id_fkey"
    FOREIGN KEY ("extension_id") REFERENCES "maintenance_schedule_extensions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_schedule_extension_audits_schedule_id_recorded_at_idx"
  ON "maintenance_schedule_extension_audits"("schedule_id", "recorded_at");

CREATE INDEX "maintenance_schedule_extension_audits_extension_id_recorded_at_idx"
  ON "maintenance_schedule_extension_audits"("extension_id", "recorded_at");

CREATE INDEX "maintenance_schedule_extension_audits_actor_id_recorded_at_idx"
  ON "maintenance_schedule_extension_audits"("actor_id", "recorded_at");

CREATE TABLE "maintenance_schedule_reschedule_audits" (
  "id" UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "extension_id" UUID,
  "source" "MaintenanceScheduleRescheduleSource" NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_name" VARCHAR(100) NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "previous_start_date" DATE,
  "new_start_date" DATE,
  "previous_target_due_date" DATE,
  "new_target_due_date" DATE,
  "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_schedule_reschedule_audits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_schedule_reschedule_audits_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "maintenance_schedules"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "maintenance_schedule_reschedule_audits_extension_id_fkey"
    FOREIGN KEY ("extension_id") REFERENCES "maintenance_schedule_extensions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "maintenance_schedule_reschedule_audits_schedule_id_changed_at_idx"
  ON "maintenance_schedule_reschedule_audits"("schedule_id", "changed_at");

CREATE INDEX "maintenance_schedule_reschedule_audits_extension_id_idx"
  ON "maintenance_schedule_reschedule_audits"("extension_id");

CREATE INDEX "maintenance_schedule_reschedule_audits_actor_id_changed_at_idx"
  ON "maintenance_schedule_reschedule_audits"("actor_id", "changed_at");

CREATE FUNCTION prevent_maintenance_schedule_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'actor_name' - 'actor_email')
         = (to_jsonb(OLD) - 'actor_name' - 'actor_email')
       AND (NEW.actor_name = OLD.actor_name OR NEW.actor_name = 'Deleted user')
       AND (
         NEW.actor_email = OLD.actor_email
         OR NEW.actor_email = 'deleted-' || OLD.actor_id::text || '@erased.invalid'
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'Maintenance schedule audit records are append-only.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "maintenance_schedule_extension_audits_append_only"
  BEFORE UPDATE OR DELETE ON "maintenance_schedule_extension_audits"
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_schedule_audit_mutation();

CREATE TRIGGER "maintenance_schedule_reschedule_audits_append_only"
  BEFORE UPDATE OR DELETE ON "maintenance_schedule_reschedule_audits"
  FOR EACH ROW EXECUTE FUNCTION prevent_maintenance_schedule_audit_mutation();
