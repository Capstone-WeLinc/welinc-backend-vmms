-- AlterTable
ALTER TABLE "maintenance_schedules" ADD COLUMN     "chief_mechanic" VARCHAR(100),
ADD COLUMN     "chief_mechanic_id" UUID;

-- CreateIndex
CREATE INDEX "maintenance_schedules_chief_mechanic_id_idx" ON "maintenance_schedules"("chief_mechanic_id");

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_chief_mechanic_id_fkey" FOREIGN KEY ("chief_mechanic_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
