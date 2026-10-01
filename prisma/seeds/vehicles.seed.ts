import { PrismaClient, VehicleStatus } from '@prisma/client';

export async function seedVehicles(prisma: PrismaClient) {
  console.log('Creating sample vehicles...');

  const garageNames = ['Marikina', 'Sta. Rosa', 'Pulilan'] as const;
  const garages = await prisma.garage.findMany({
    where: { name: { in: [...garageNames] } },
    select: { id: true, name: true },
  });
  const garageIds = new Map(garages.map((garage) => [garage.name, garage.id]));
  const missingGarage = garageNames.find((name) => !garageIds.has(name));
  if (missingGarage) {
    throw new Error(`Cannot seed vehicles: registered garage branch "${missingGarage}" is missing.`);
  }

  const vehiclesData = [
    {
      plateNumber: 'NDG 5821',
      make: 'Isuzu',
      model: 'Isuzu Elf NKR',
      year: 2020,
      engineType: 'Diesel',
      truckSizeCategory: 'Light Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 45000,
      garageName: 'Marikina',
    },
    {
      plateNumber: 'CAK 9043',
      make: 'Mitsubishi',
      model: 'Mitsubishi Fuso FE',
      year: 2019,
      engineType: 'Diesel',
      truckSizeCategory: 'Medium Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 72000,
      garageName: 'Sta. Rosa',
    },
    {
      plateNumber: 'WOB 2947',
      make: 'Hino',
      model: 'Hino 300 Series',
      year: 2021,
      engineType: 'Diesel',
      truckSizeCategory: 'Light Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 31500,
      garageName: 'Pulilan',
    },
    {
      plateNumber: 'PXW 382',
      make: 'Toyota',
      model: 'Toyota Hilux',
      year: 2020,
      engineType: 'Diesel',
      truckSizeCategory: 'Light Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 18000,
      garageName: 'Marikina',
    },
    {
      plateNumber: 'TGD 908',
      make: 'Foton',
      model: 'Foton Tornado',
      year: 2018,
      engineType: 'Diesel',
      truckSizeCategory: 'Heavy Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 92000,
      garageName: 'Sta. Rosa',
    },
    {
      plateNumber: 'NRE 471',
      make: 'Isuzu',
      model: 'Isuzu Giga',
      year: 2022,
      engineType: 'Diesel',
      truckSizeCategory: 'Heavy Duty',
      status: VehicleStatus.AVAILABLE,
      odometer: 145000,
      garageName: 'Pulilan',
    },
  ];

  const vehicles = await Promise.all(
    vehiclesData.map(({ garageName, ...vehicle }) => {
      const garageId = garageIds.get(garageName);
      if (!garageId) {
        throw new Error(`Cannot seed vehicle "${vehicle.plateNumber}": garage branch "${garageName}" is missing.`);
      }
      return prisma.vehicle.upsert({
        where: { plateNumber: vehicle.plateNumber },
        update: {
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          engineType: vehicle.engineType,
          truckSizeCategory: vehicle.truckSizeCategory,
          status: vehicle.status,
          odometer: vehicle.odometer,
          garageId,
        },
        create: { ...vehicle, garageId },
      });
    }),
  );

  console.log(`  Created ${vehicles.length} sample vehicles\n`);
  return vehicles;
}
