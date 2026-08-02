/*
  Warnings:

  - You are about to drop the column `work_order_progress` on the `maintenance_schedules` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "maintenance_schedules" DROP COLUMN "work_order_progress",
ADD COLUMN     "labor_cost" DECIMAL(10,2),
ADD COLUMN     "parts_cost" DECIMAL(10,2),
ADD COLUMN     "total_cost" DECIMAL(10,2);
