CREATE TYPE "VehicleAccountType" AS ENUM ('ONLINE', 'CORPORATE');

ALTER TABLE "vehicles"
ADD COLUMN "make" VARCHAR(80),
ADD COLUMN "year" INTEGER,
ADD COLUMN "engine_type" VARCHAR(50),
ADD COLUMN "truck_size_category" VARCHAR(50),
ADD COLUMN "account_type" "VehicleAccountType";
