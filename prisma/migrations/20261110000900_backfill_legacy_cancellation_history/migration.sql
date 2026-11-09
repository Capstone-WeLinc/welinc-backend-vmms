UPDATE "maintenance_schedule_cancellations"
SET "review_status" = 'LEGACY'
WHERE "review_status" = 'APPROVED'
  AND "reviewed_at" IS NULL;
