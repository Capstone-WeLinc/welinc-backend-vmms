CREATE TABLE "fuel_stations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(100) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_stations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fuel_stations_name_key" ON "fuel_stations"("name");
INSERT INTO "fuel_stations" ("name") VALUES ('Petron'), ('Shell'), ('Sea Oil'), ('Arriba');

CREATE TABLE "fuel_fill_ups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "vehicle_id" UUID NOT NULL,
  "station_id" UUID NOT NULL,
  "filled_by" VARCHAR(100) NOT NULL,
  "entered_by_id" UUID NOT NULL,
  "entry_date" DATE NOT NULL,
  "liters" DECIMAL(10,2) NOT NULL,
  "price_per_liter" DECIMAL(10,2) NOT NULL,
  "total_cost" DECIMAL(12,2) NOT NULL,
  "odometer" INTEGER NOT NULL,
  "is_full_tank" BOOLEAN NOT NULL DEFAULT false,
  "is_voided" BOOLEAN NOT NULL DEFAULT false,
  "void_reason" TEXT,
  "voided_by_id" UUID,
  "voided_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_fill_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_fill_ups_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fuel_fill_ups_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "fuel_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "fuel_fill_ups_vehicle_id_entry_date_created_at_idx" ON "fuel_fill_ups"("vehicle_id", "entry_date", "created_at");
CREATE INDEX "fuel_fill_ups_is_voided_entry_date_idx" ON "fuel_fill_ups"("is_voided", "entry_date");

CREATE TABLE "fuel_anomalies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fill_up_id" UUID NOT NULL,
  "vehicle_id" UUID NOT NULL,
  "efficiency" DECIMAL(10,2) NOT NULL,
  "rolling_average" DECIMAL(10,2) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  "note" TEXT,
  "noted_at" TIMESTAMPTZ(6),
  "noted_by_id" UUID,
  "acknowledged_at" TIMESTAMPTZ(6),
  "acknowledged_by_id" UUID,
  "acknowledgment" TEXT,
  "resolved_at" TIMESTAMPTZ(6),
  "resolved_by_id" UUID,
  "notified_day_1_at" TIMESTAMPTZ(6),
  "notified_day_3_at" TIMESTAMPTZ(6),
  "notified_day_7_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_anomalies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_anomalies_fill_up_id_fkey" FOREIGN KEY ("fill_up_id") REFERENCES "fuel_fill_ups"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fuel_anomalies_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fuel_anomalies_fill_up_id_key" ON "fuel_anomalies"("fill_up_id");
CREATE INDEX "fuel_anomalies_status_created_at_idx" ON "fuel_anomalies"("status", "created_at");

CREATE TABLE "fuel_anomaly_attachments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "anomaly_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "storage_name" VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  "uploaded_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_anomaly_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_anomaly_attachments_anomaly_id_fkey" FOREIGN KEY ("anomaly_id") REFERENCES "fuel_anomalies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "fuel_anomaly_attachments_anomaly_id_created_at_idx" ON "fuel_anomaly_attachments"("anomaly_id", "created_at");

CREATE TABLE "fuel_audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fill_up_id" UUID,
  "actor_id" UUID NOT NULL,
  "actor_email" VARCHAR(255) NOT NULL,
  "action" VARCHAR(40) NOT NULL,
  "reason" TEXT,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_audit_logs_fill_up_id_fkey" FOREIGN KEY ("fill_up_id") REFERENCES "fuel_fill_ups"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "fuel_audit_logs_fill_up_id_created_at_idx" ON "fuel_audit_logs"("fill_up_id", "created_at");
CREATE INDEX "fuel_audit_logs_actor_id_created_at_idx" ON "fuel_audit_logs"("actor_id", "created_at");
