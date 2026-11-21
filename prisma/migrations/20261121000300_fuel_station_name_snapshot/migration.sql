ALTER TABLE "fuel_fill_ups"
  ADD COLUMN "station_name_snapshot" VARCHAR(100);

UPDATE "fuel_fill_ups" AS fill_up
SET "station_name_snapshot" = station."name"
FROM "fuel_stations" AS station
WHERE station."id" = fill_up."station_id";

ALTER TABLE "fuel_fill_ups"
  ALTER COLUMN "station_name_snapshot" SET NOT NULL;
