-- Remove BMS booking and legacy driver entities. Preserve VMMS work-order records
-- while renaming the repair-ticket terminology to work orders.
DROP TABLE "bookings";

ALTER TABLE "repair_tickets" DROP CONSTRAINT "repair_tickets_driver_id_fkey";
ALTER TABLE "repair_tickets" DROP COLUMN "driver_id";
ALTER TABLE "repair_tickets" RENAME TO "work_orders";
ALTER TABLE "work_orders" RENAME COLUMN "repair_number" TO "work_order_number";
ALTER TABLE "work_orders" RENAME COLUMN "repair_status" TO "status";
ALTER TABLE "work_orders" RENAME CONSTRAINT "repair_tickets_pkey" TO "work_orders_pkey";
ALTER TABLE "work_orders" RENAME CONSTRAINT "repair_tickets_vehicle_id_fkey" TO "work_orders_vehicle_id_fkey";
ALTER TABLE "work_orders" RENAME CONSTRAINT "repair_tickets_garage_id_fkey" TO "work_orders_garage_id_fkey";

ALTER INDEX "repair_tickets_repair_number_key" RENAME TO "work_orders_work_order_number_key";
ALTER INDEX "repair_tickets_repair_status_created_at_idx" RENAME TO "work_orders_status_created_at_idx";
ALTER INDEX "repair_tickets_vehicle_id_idx" RENAME TO "work_orders_vehicle_id_idx";

ALTER TABLE "repair_issues" RENAME COLUMN "repair_ticket_id" TO "work_order_id";
ALTER TABLE "repair_issues" RENAME CONSTRAINT "repair_issues_repair_ticket_id_fkey" TO "repair_issues_work_order_id_fkey";
ALTER TABLE "repair_parts" RENAME COLUMN "repair_ticket_id" TO "work_order_id";
ALTER TABLE "repair_parts" RENAME CONSTRAINT "repair_parts_repair_ticket_id_fkey" TO "repair_parts_work_order_id_fkey";
ALTER TABLE "shop_change_logs" RENAME COLUMN "repair_ticket_id" TO "work_order_id";
ALTER TABLE "shop_change_logs" RENAME CONSTRAINT "shop_change_logs_repair_ticket_id_fkey" TO "shop_change_logs_work_order_id_fkey";
ALTER TABLE "audit_logs" RENAME COLUMN "repair_ticket_id" TO "work_order_id";
ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_repair_ticket_id_fkey" TO "audit_logs_work_order_id_fkey";
ALTER INDEX "audit_logs_repair_ticket_id_created_at_idx" RENAME TO "audit_logs_work_order_id_created_at_idx";

ALTER TABLE "_RepairTicketMechanics" RENAME TO "_WorkOrderMechanics";
ALTER TABLE "_WorkOrderMechanics" RENAME CONSTRAINT "_RepairTicketMechanics_AB_pkey" TO "_WorkOrderMechanics_AB_pkey";
ALTER TABLE "_WorkOrderMechanics" RENAME CONSTRAINT "_RepairTicketMechanics_A_fkey" TO "_WorkOrderMechanics_A_fkey";
ALTER TABLE "_WorkOrderMechanics" RENAME CONSTRAINT "_RepairTicketMechanics_B_fkey" TO "_WorkOrderMechanics_B_fkey";
ALTER INDEX "_RepairTicketMechanics_B_index" RENAME TO "_WorkOrderMechanics_B_index";

ALTER TYPE "RepairStatus" RENAME TO "WorkOrderStatus";
DROP TABLE "drivers";

UPDATE "work_orders" SET "work_order_number" = regexp_replace("work_order_number", '^REP-', 'WO-') WHERE "work_order_number" LIKE 'REP-%';

-- Customer support is a BMS-only role and is not part of the VMMS role set.
DELETE FROM "user_roles" WHERE "role"::text = 'CUSTOMER_SUPPORT';
ALTER TYPE "UserRole" RENAME TO "UserRole_old";
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MECHANIC', 'OPERATIONS', 'CHIEF_MECHANIC');
ALTER TABLE "user_roles" ALTER COLUMN "role" TYPE "UserRole" USING ("role"::text::"UserRole");
DROP TYPE "UserRole_old";
