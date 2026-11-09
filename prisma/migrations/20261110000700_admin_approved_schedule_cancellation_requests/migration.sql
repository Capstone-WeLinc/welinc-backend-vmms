CREATE TYPE "MaintenanceCancellationReviewStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'REJECTED'
);

ALTER TABLE "maintenance_schedule_cancellations"
  ADD COLUMN "review_status" "MaintenanceCancellationReviewStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "reviewed_by_name" VARCHAR(100),
  ADD COLUMN "reviewed_by_email" VARCHAR(255),
  ADD COLUMN "review_reason" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);

CREATE INDEX "maintenance_schedule_cancellations_review_status_created_at_idx"
  ON "maintenance_schedule_cancellations"("review_status", "created_at");

CREATE UNIQUE INDEX "maintenance_schedule_cancellations_one_pending_per_schedule_idx"
  ON "maintenance_schedule_cancellations"("schedule_id")
  WHERE "review_status" = 'PENDING';
