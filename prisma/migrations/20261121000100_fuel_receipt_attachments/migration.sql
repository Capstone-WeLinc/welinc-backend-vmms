CREATE TABLE "fuel_receipt_attachments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "fill_up_id" UUID NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "storage_name" VARCHAR(255) NOT NULL,
  "content_type" VARCHAR(100) NOT NULL,
  "uploaded_by_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fuel_receipt_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "fuel_receipt_attachments_fill_up_id_fkey" FOREIGN KEY ("fill_up_id") REFERENCES "fuel_fill_ups"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "fuel_receipt_attachments_fill_up_id_key" ON "fuel_receipt_attachments"("fill_up_id");
