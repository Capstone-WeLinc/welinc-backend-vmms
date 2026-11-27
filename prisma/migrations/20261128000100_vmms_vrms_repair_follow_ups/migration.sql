-- CreateEnum
CREATE TYPE "VmmsRepairReferralSource" AS ENUM ('INSPECTION', 'FUEL_ANOMALY');

-- CreateEnum
CREATE TYPE "VrmsRetirementRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "VrmsRetirementDecision" AS ENUM ('APPROVED', 'DECLINED');

-- AlterTable
ALTER TABLE "vmms_repair_referrals" ADD COLUMN     "fuel_transaction_id" UUID,
ADD COLUMN     "source" "VmmsRepairReferralSource" NOT NULL DEFAULT 'INSPECTION',
ALTER COLUMN "maintenance_schedule_id" DROP NOT NULL,
ALTER COLUMN "work_order_number" DROP NOT NULL;

-- CreateTable
CREATE TABLE "vrms_retirement_requests" (
    "event_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "repair_ticket_number" VARCHAR(32) NOT NULL,
    "reason" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "VrmsRetirementRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decision_reason" TEXT,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vrms_retirement_requests_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "vrms_retirement_decision_outbox" (
    "event_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "decision" "VrmsRetirementDecision" NOT NULL,
    "reason" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" VARCHAR(80),
    "sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vrms_retirement_decision_outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "vrms_repeat_repair_alerts" (
    "event_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "category" VARCHAR(120) NOT NULL,
    "repair_ticket_numbers" JSONB NOT NULL,
    "window_days" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vrms_repeat_repair_alerts_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vrms_retirement_requests_event_id_key" ON "vrms_retirement_requests"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "vrms_retirement_requests_repair_ticket_id_key" ON "vrms_retirement_requests"("repair_ticket_id");

-- CreateIndex
CREATE INDEX "vrms_retirement_requests_status_occurred_at_request_id_idx" ON "vrms_retirement_requests"("status", "occurred_at", "request_id");

-- CreateIndex
CREATE INDEX "vrms_retirement_requests_vehicle_id_status_idx" ON "vrms_retirement_requests"("vehicle_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "vrms_retirement_decision_outbox_request_id_key" ON "vrms_retirement_decision_outbox"("request_id");

-- CreateIndex
CREATE INDEX "vrms_retirement_decision_outbox_sent_at_next_attempt_at_idx" ON "vrms_retirement_decision_outbox"("sent_at", "next_attempt_at");

-- CreateIndex
CREATE INDEX "vrms_repeat_repair_alerts_occurred_at_event_id_idx" ON "vrms_repeat_repair_alerts"("occurred_at", "event_id");

-- CreateIndex
CREATE INDEX "vrms_repeat_repair_alerts_vehicle_id_occurred_at_idx" ON "vrms_repeat_repair_alerts"("vehicle_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "vmms_repair_referrals_fuel_transaction_id_key" ON "vmms_repair_referrals"("fuel_transaction_id");

-- AddForeignKey
ALTER TABLE "vmms_repair_referrals" ADD CONSTRAINT "vmms_repair_referrals_fuel_transaction_id_fkey" FOREIGN KEY ("fuel_transaction_id") REFERENCES "fuel_fill_ups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vrms_retirement_requests" ADD CONSTRAINT "vrms_retirement_requests_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vrms_retirement_requests" ADD CONSTRAINT "vrms_retirement_requests_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "vrms_repair_integration_states"("repair_ticket_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vrms_retirement_decision_outbox" ADD CONSTRAINT "vrms_retirement_decision_outbox_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "vrms_retirement_requests"("request_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vrms_repeat_repair_alerts" ADD CONSTRAINT "vrms_repeat_repair_alerts_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
