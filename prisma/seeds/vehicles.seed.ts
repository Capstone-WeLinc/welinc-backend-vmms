import { PrismaClient, VehicleStatus } from '@prisma/client';
import { seedId } from './seed-id';
import { suiteSeedPeople } from './users.seed';

export async function seedVehicles(prisma: PrismaClient) {
  console.log('Creating sample vehicles...');

  const garageNames = ['Marikina', 'Sta. Rosa', 'Pulilan'] as const;
  const garages = await prisma.garage.findMany({
    where: {
      name: { in: [...garageNames] },
      isActive: true,
      deletedAt: null,
    },
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
      odometer: 35000,
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
      odometer: 19000,
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
        update: {},
        create: {
          ...vehicle,
          id: seedId(`vehicle:${vehicle.plateNumber}`),
          garageId,
        },
      });
    }),
  );

  const newVehicles = vehicles.filter(
    (vehicle) => vehicle.id === seedId(`vehicle:${vehicle.plateNumber}`),
  );
  if (newVehicles.length) {
    const operationsPerson = suiteSeedPeople().find(
      (person) =>
        person.state === 'active' &&
        person.roles.some(
          (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
        ),
    );
    if (!operationsPerson)
      throw new Error(
        'Cannot seed odometer history without an active VMMS Operations identity.',
      );

    const auditRows = newVehicles.flatMap((vehicle) => {
      const anchor = new Date(vehicle.createdAt);
      anchor.setUTCHours(12, 0, 0, 0);
      return [60, 30, 0].map((daysAgo, index) => {
        const createdAt = new Date(anchor);
        createdAt.setUTCDate(createdAt.getUTCDate() - daysAgo);
        return {
          id: seedId(`odometer:${vehicle.plateNumber}:${index}`),
          vehicleId: vehicle.id,
          userId: operationsPerson.id,
          email: operationsPerson.email.toLowerCase(),
          action: 'ODOMETER_UPDATED',
          fieldName: 'odometer',
          previousValue: String(
            vehicle.odometer - (3 - index) * 3000,
          ),
          newValue: String(vehicle.odometer - (2 - index) * 3000),
          createdAt,
        };
      });
    });
    await prisma.vehicleAuditLog.createMany({
      data: auditRows,
      skipDuplicates: true,
    });
  }

  console.log(`  Created ${vehicles.length} sample vehicles\n`);
  return vehicles;
}
