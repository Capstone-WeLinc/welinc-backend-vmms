import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { seedGarages } from './seeds/garages.seed';
import { seedUsers } from './seeds/users.seed';
import { seedVehicles } from './seeds/vehicles.seed';
import { seedWorkOrders } from './seeds/work-orders.seed';
import { seedVmms } from './seeds/vmms.seed';

const pool = new pg.Pool({
  connectionString: process.env['DATABASE_URL'],
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function cleanDatabase(prisma: PrismaClient) {
  console.log('Cleaning database...');
  await prisma.auditLog.deleteMany({});
  await prisma.shopChangeLog.deleteMany({});
  await prisma.repairPart.deleteMany({});
  await prisma.repairIssue.deleteMany({});
  await prisma.workOrder.deleteMany({});
  
  // Clean self-referencing maintenance schedules
  await prisma.maintenanceSchedule.updateMany({
    data: { previousScheduleId: null },
  });
  await prisma.maintenanceSchedule.deleteMany({});
  
  await prisma.checklistItem.deleteMany({});
  await prisma.checklistTemplate.deleteMany({});
  
  await prisma.mechanic.deleteMany({});
  await prisma.vehicle.deleteMany({});
  await prisma.garage.deleteMany({});
  
  await prisma.passwordResetToken.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.userRoleAssignment.deleteMany({});
  await prisma.user.deleteMany({});
  console.log('Database cleaned successfully!\n');
}

async function main() {
  console.log('Seeding database in modular mode...\n');

  // 0. Clean database first
  await cleanDatabase(prisma);

  // 1. Garages (Independent)
  await seedGarages(prisma);

  // 2. Users & Mechanics (Independent)
  await seedUsers(prisma);

  // 3. Vehicles (Independent)
  await seedVehicles(prisma);

  // 4. VMMS work orders (Depends on garages, vehicles, mechanics, users)
  await seedWorkOrders(prisma);

  // 5. VMMS schedules (Depends on garages, vehicles, mechanics)
  await seedVmms(prisma);

  console.log('Database seeded successfully!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Login credentials:');
  console.log('  VMMS Admin → email: vmms.admin@welinc.com password: admin1234');
  console.log('  Operations → email: ops.user@welinc.com   password: ops1234 (VMMS)');
  console.log('  VMMS Chief Mechanic → email: vmms.chiefmech@welinc.com  password: chiefmech1234 (VMMS)');
  console.log('  VMMS Chief Mechanic → email: vmms.chiefmech2@welinc.com password: chiefmech1234 (VMMS)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
