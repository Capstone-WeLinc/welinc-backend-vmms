CREATE TABLE "maintenance_costing_export_audit" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "format" VARCHAR(10) NOT NULL,
  "from_date" DATE NOT NULL,
  "to_date" DATE NOT NULL,
  "selected_truck_id" UUID,
  "selected_truck_plate" VARCHAR(20),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_costing_export_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "maintenance_costing_export_audit_format_check" CHECK ("format" IN ('PDF', 'XLSX')),
  CONSTRAINT "maintenance_costing_export_audit_date_range_check" CHECK ("from_date" <= "to_date")
);

CREATE INDEX "maintenance_costing_export_audit_created_at_idx"
  ON "maintenance_costing_export_audit"("created_at");
CREATE INDEX "maintenance_costing_export_audit_actor_id_created_at_idx"
  ON "maintenance_costing_export_audit"("actor_id", "created_at");

CREATE TRIGGER vmms_protect_append_only
BEFORE UPDATE OR DELETE ON "maintenance_costing_export_audit"
FOR EACH ROW EXECUTE FUNCTION vmms_protect_immutable_audit('actor_id', '', 'actor_email');
