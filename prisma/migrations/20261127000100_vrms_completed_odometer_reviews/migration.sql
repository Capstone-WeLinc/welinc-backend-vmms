CREATE TYPE "VrmsRepairOdometerReviewStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

CREATE TABLE "vrms_repair_odometer_reviews" (
    "id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "service_odometer_reading" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "VrmsRepairOdometerReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vrms_repair_odometer_reviews_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vrms_repair_odometer_reviews_event_id_key"
    ON "vrms_repair_odometer_reviews"("event_id");
CREATE INDEX "vrms_repair_odometer_reviews_status_occurred_at_id_idx"
    ON "vrms_repair_odometer_reviews"("status", "occurred_at", "id");
CREATE INDEX "vrms_repair_odometer_reviews_vehicle_id_created_at_idx"
    ON "vrms_repair_odometer_reviews"("vehicle_id", "created_at");

ALTER TABLE "vrms_repair_odometer_reviews"
    ADD CONSTRAINT "vrms_repair_odometer_reviews_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "vrms_repair_event_receipts"("event_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vrms_repair_odometer_reviews"
    ADD CONSTRAINT "vrms_repair_odometer_reviews_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
