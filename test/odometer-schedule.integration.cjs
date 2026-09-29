// Build first. Every test fixture and vehicle-reading change is rolled back.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PrismaService } = require('../dist/src/shared/prisma.service');
const { MaintenanceSchedulesService } = require('../dist/src/modules/vmms/maintenance-schedules/maintenance-schedules.service');

(async () => {
  const prisma = new PrismaService();
  const fixtureId = randomUUID();
  const plate = `KM-${fixtureId.slice(0, 8)}`;
  try {
    const mechanic = await prisma.user.findFirst({ where: { isActive: true, deletedAt: null, roles: { some: { system: 'VMMS', role: 'MECHANIC' } } } });
    assert.ok(mechanic);
    const rollback = new Error('Rollback mileage fixtures');
    await assert.rejects(() => prisma.$transaction(async (tx) => {
      const template = await tx.checklistTemplate.create({ data: { id: fixtureId, type: `Mileage fixture ${fixtureId}`, items: { create: [{ text: 'Check item', order: 0 }] } } });
      await tx.vehicle.create({ data: { plateNumber: plate, model: 'Test only', odometer: 15000 } });
      const service = new MaintenanceSchedulesService({ ...tx, $queryRaw: tx.$queryRaw.bind(tx), $transaction: (callback) => callback(tx) });
      service.syncVehicleStatus = async () => {};
      const input = { vehicleId: plate, title: template.type, checklistTemplateId: template.id, assignedDriver: mechanic.name, assignedMechanicId: mechanic.id,
        triggerType: 'ODOMETER', startDate: '2099-01-01', odometerReading: '10000', startingReferenceReadingKm: '10000', intervalKm: '5000', bufferDistanceKm: '500' };
      await assert.rejects(() => service.create(input), /must be greater than the truck's current/);
      for (const intervalKm of ['0', '-5', '5000.5', '5000abc', '2147483648']) {
        await assert.rejects(() => service.create({ ...input, intervalKm }), (error) => error.getStatus() === 400);
      }
      assert.equal(await tx.maintenanceSchedule.count({ where: { vehicleId: plate } }), 0);
      await tx.vehicle.update({ where: { plateNumber: plate }, data: { odometer: 14000 } });
      const created = await service.create(input);
      assert.equal(created.odometerReading, '14000');
      assert.equal(created.startingReferenceReadingKm, '10000');
      assert.equal(created.intervalKm, '5000');
      await tx.vehicle.update({ where: { plateNumber: plate }, data: { odometer: 16000 } });
      const updated = await service.update(created.id, { ...input, odometerReading: '13000' });
      assert.equal(updated.odometerReading, '16000');
      await assert.rejects(() => service.update(created.id, { ...input, intervalKm: '4000' }), /must be greater than the truck's current/);
      assert.equal((await tx.maintenanceSchedule.findUniqueOrThrow({ where: { id: created.id } })).intervalKm, 5000);
      await tx.vehicle.update({ where: { plateNumber: plate }, data: { isActive: false } });
      await assert.rejects(() => service.update(created.id, input), /active truck/);
      throw rollback;
    }), (error) => error === rollback);
    assert.equal(await prisma.vehicle.findUnique({ where: { plateNumber: plate } }), null);
    assert.equal(await prisma.checklistTemplate.findUnique({ where: { id: fixtureId } }), null);
    console.log('PASS: authoritative truck mileage blocks stale thresholds; malformed numbers never save; odometer-only updates can record due work. Fixtures rolled back.');
  } finally { await prisma.onApplicationShutdown(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
