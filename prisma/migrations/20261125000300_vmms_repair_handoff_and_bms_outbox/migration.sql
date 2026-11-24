ALTER TYPE "VrmsRepairEventType" ADD VALUE 'STATUS_UPDATED';

CREATE TYPE "VmmsRepairReferralStatus" AS ENUM (
    'QUEUED',
    'SENT',
    'FAILED',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED'
);

CREATE TYPE "VrmsRepairReferralEventType" AS ENUM ('REJECTED');

ALTER TABLE "vehicles"
    ADD COLUMN "availability_version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "vrms_repair_integration_states"
    ADD COLUMN "repair_ticket_number" VARCHAR(32),
    ADD COLUMN "repair_status" VARCHAR(32),
    ADD COLUMN "outside_shop_name" VARCHAR(150),
    ADD COLUMN "accepted_referral_ids" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "vrms_repair_event_receipts"
    ADD COLUMN "repair_ticket_number" VARCHAR(32),
    ADD COLUMN "repair_status" VARCHAR(32),
    ADD COLUMN "outside_shop_name" VARCHAR(150),
    ADD COLUMN "accepted_referral_ids" JSONB NOT NULL DEFAULT '[]';

CREATE TABLE "vmms_repair_referrals" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "maintenance_schedule_id" UUID NOT NULL,
    "work_order_number" VARCHAR(32) NOT NULL,
    "status" "VmmsRepairReferralStatus" NOT NULL DEFAULT 'QUEUED',
    "request_payload" JSONB NOT NULL,
    "repair_ticket_id" UUID,
    "repair_ticket_number" VARCHAR(32),
    "repair_status" VARCHAR(32),
    "outside_shop_name" VARCHAR(150),
    "outcome_reason" TEXT,
    "outcome_event_id" UUID,
    "outcome_occurred_at" TIMESTAMPTZ(6),
    "attempt_window_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "next_attempt_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "manual_retry_count" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(80),
    "failed_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vmms_repair_referrals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vrms_repair_referral_event_receipts" (
    "event_id" UUID NOT NULL,
    "referral_id" UUID NOT NULL,
    "event_type" "VrmsRepairReferralEventType" NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vrms_repair_referral_event_receipts_pkey" PRIMARY KEY ("event_id")
);

CREATE TABLE "bms_vehicle_availability_events" (
    "event_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "event_version" INTEGER NOT NULL,
    "status" "VehicleStatus" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(80),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bms_vehicle_availability_events_pkey" PRIMARY KEY ("event_id")
);

CREATE UNIQUE INDEX "vmms_repair_referrals_outcome_event_id_key"
    ON "vmms_repair_referrals"("outcome_event_id");
CREATE INDEX "vmms_repair_referrals_status_next_attempt_at_idx"
    ON "vmms_repair_referrals"("status", "next_attempt_at");
CREATE INDEX "vmms_repair_referrals_maintenance_schedule_id_created_at_idx"
    ON "vmms_repair_referrals"("maintenance_schedule_id", "created_at");
CREATE INDEX "vmms_repair_referrals_vehicle_id_created_at_idx"
    ON "vmms_repair_referrals"("vehicle_id", "created_at");

CREATE INDEX "vrms_repair_referral_event_receipts_referral_id_received_at_idx"
    ON "vrms_repair_referral_event_receipts"("referral_id", "received_at");

CREATE UNIQUE INDEX "bms_vehicle_availability_events_vehicle_id_event_version_key"
    ON "bms_vehicle_availability_events"("vehicle_id", "event_version");
CREATE INDEX "bms_vehicle_availability_events_sent_at_next_attempt_at_idx"
    ON "bms_vehicle_availability_events"("sent_at", "next_attempt_at");
CREATE INDEX "bms_vehicle_availability_events_vehicle_id_event_version_idx"
    ON "bms_vehicle_availability_events"("vehicle_id", "event_version");

ALTER TABLE "vmms_repair_referrals"
    ADD CONSTRAINT "vmms_repair_referrals_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "vmms_repair_referrals_maintenance_schedule_id_fkey"
    FOREIGN KEY ("maintenance_schedule_id") REFERENCES "maintenance_schedules"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vrms_repair_referral_event_receipts"
    ADD CONSTRAINT "vrms_repair_referral_event_receipts_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "vmms_repair_referrals"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bms_vehicle_availability_events"
    ADD CONSTRAINT "bms_vehicle_availability_events_vehicle_id_fkey"
    FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
