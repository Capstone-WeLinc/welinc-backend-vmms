BEGIN;

DROP TABLE "repair_issues";
DROP TABLE "repair_parts";
DROP TABLE "shop_change_logs";
DROP TABLE "audit_logs";
DROP TABLE "_WorkOrderMechanics";
DROP TABLE "work_orders";
DROP TYPE "WorkOrderStatus";

COMMIT;
