CREATE TYPE "VrmsRepairIntegrationStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');
CREATE TYPE "VrmsRepairEventType" AS ENUM ('OPENED', 'LINKS_UPDATED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "vrms_repair_integration_states" (
    "repair_ticket_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "VrmsRepairIntegrationStatus" NOT NULL,
    "last_event_version" INTEGER NOT NULL,
    "maintenance_schedule_ids" JSONB NOT NULL DEFAULT '[]',
    "last_occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vrms_repair_integration_states_pkey" PRIMARY KEY ("repair_ticket_id")
);

CREATE TABLE "vrms_repair_event_receipts" (
    "event_id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "event_version" INTEGER NOT NULL,
    "event_type" "VrmsRepairEventType" NOT NULL,
    "vmms_vehicle_id" UUID NOT NULL,
    "maintenance_schedule_ids" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "service_odometer_reading" INTEGER,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vrms_repair_event_receipts_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "vrms_repair_integration_states_vehicle_id_status_idx"
    ON "vrms_repair_integration_states"("vehicle_id", "status");
CREATE UNIQUE INDEX "vrms_repair_event_receipts_repair_ticket_id_event_version_key"
    ON "vrms_repair_event_receipts"("repair_ticket_id", "event_version");
CREATE INDEX "vrms_repair_event_receipts_repair_ticket_id_received_at_idx"
    ON "vrms_repair_event_receipts"("repair_ticket_id", "received_at");

ALTER TABLE "vrms_repair_integration_states"
    ADD CONSTRAINT "vrms_repair_integration_states_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vrms_repair_event_receipts"
    ADD CONSTRAINT "vrms_repair_event_receipts_repair_ticket_id_fkey"
    FOREIGN KEY ("repair_ticket_id") REFERENCES "vrms_repair_integration_states"("repair_ticket_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
