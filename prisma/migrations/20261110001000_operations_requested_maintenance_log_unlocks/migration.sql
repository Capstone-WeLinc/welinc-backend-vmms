ALTER TABLE "maintenance_log_edit_unlocks"
  ADD COLUMN "review_status" "MaintenanceCancellationReviewStatus" NOT NULL DEFAULT 'APPROVED',
  ADD COLUMN "reviewed_by_id" UUID,
  ADD COLUMN "reviewed_by_name" VARCHAR(100),
  ADD COLUMN "reviewed_by_email" VARCHAR(255),
  ADD COLUMN "review_reason" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "activated_at" TIMESTAMPTZ(6);

-- Preserve the access window for historical Admin-issued unlocks.
UPDATE "maintenance_log_edit_unlocks"
SET "activated_at" = "created_at"
WHERE "review_status" = 'APPROVED';

CREATE INDEX "maintenance_log_edit_unlocks_review_status_created_at_idx"
  ON "maintenance_log_edit_unlocks"("review_status", "created_at");
