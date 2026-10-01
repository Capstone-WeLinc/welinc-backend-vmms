ALTER TABLE "vehicles"
ADD COLUMN "garage_id" UUID;

CREATE INDEX "vehicles_garage_id_idx" ON "vehicles"("garage_id");

ALTER TABLE "vehicles"
ADD CONSTRAINT "vehicles_garage_id_fkey"
FOREIGN KEY ("garage_id") REFERENCES "garages"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
