ALTER TABLE "vehicles"
ADD COLUMN "default_maintenance_interval_km" INTEGER,
ADD COLUMN "default_maintenance_buffer_km" INTEGER;

ALTER TABLE "vehicles"
ADD CONSTRAINT "vehicles_default_maintenance_interval_positive"
CHECK ("default_maintenance_interval_km" IS NULL OR "default_maintenance_interval_km" > 0),
ADD CONSTRAINT "vehicles_default_maintenance_buffer_nonnegative"
CHECK ("default_maintenance_buffer_km" IS NULL OR "default_maintenance_buffer_km" >= 0),
ADD CONSTRAINT "vehicles_default_maintenance_values_paired"
CHECK (
  ("default_maintenance_interval_km" IS NULL) =
  ("default_maintenance_buffer_km" IS NULL)
);

CREATE TABLE "vehicle_maintenance_defaults" (
  "vehicle_id" UUID NOT NULL,
  "checklist_template_id" UUID NOT NULL,
  "interval_km" INTEGER NOT NULL,
  "buffer_distance_km" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vehicle_maintenance_defaults_pkey"
    PRIMARY KEY ("vehicle_id", "checklist_template_id"),
  CONSTRAINT "vehicle_maintenance_defaults_interval_positive"
    CHECK ("interval_km" > 0),
  CONSTRAINT "vehicle_maintenance_defaults_buffer_nonnegative"
    CHECK ("buffer_distance_km" >= 0),
  CONSTRAINT "vehicle_maintenance_defaults_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vehicle_maintenance_defaults_checklist_template_id_fkey"
    FOREIGN KEY ("checklist_template_id") REFERENCES "checklist_templates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
