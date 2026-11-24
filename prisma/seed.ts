import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { seedGarages } from './seeds/garages.seed';
import { seedUsers } from './seeds/users.seed';
import { seedVehicles } from './seeds/vehicles.seed';
import { seedVmms } from './seeds/vmms.seed';

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

async function main() {
  if (process.env['NODE_ENV'] === 'production' && process.env['SEED_ALLOW'] !== 'staging') {
    throw new Error('Production seeding is disabled. Set SEED_ALLOW=staging only for an approved staging seed run.');
  }
  const [vehicles, schedules, garages] = await Promise.all([
    prisma.vehicle.count(), prisma.maintenanceSchedule.count(), prisma.garage.count(),
  ]);
  if (vehicles || schedules || garages) {
    console.log('VMMS already has core data; preserving existing rows.');
  } else {
    await seedGarages(prisma);
    await seedUsers(prisma); // copies suite people; creates no local accounts
    await seedVehicles(prisma);
    await seedVmms(prisma);
    console.log('VMMS sample fleet seeded from suite people.json.');
  }

}

main().catch((error) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
  await pool.end();
});
