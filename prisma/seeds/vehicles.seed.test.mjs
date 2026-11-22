import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedVehicles } from './vehicles.seed.ts';

const branches = [
  { id: 'garage-marikina', name: 'Marikina' },
  { id: 'garage-sta-rosa', name: 'Sta. Rosa' },
  { id: 'garage-pulilan', name: 'Pulilan' },
];

function createPrismaMock(garages = branches, existingVehicles = []) {
  const upserts = [];
  const auditRows = [];
  return {
    upserts,
    auditRows,
    garage: { findMany: async () => garages },
    vehicle: {
      upsert: async (args) => {
        upserts.push(args);
        const existing = existingVehicles.find(
          (vehicle) => vehicle.plateNumber === args.where.plateNumber,
        );
        return existing ?? { ...args.create, createdAt: new Date('2026-01-01T12:00:00.000Z') };
      },
    },
    vehicleAuditLog: {
      createMany: async ({ data }) => {
        auditRows.push(...data);
        return { count: data.length };
      },
    },
  };
}

test('seeded vehicles receive registered garage IDs and synthetic odometer history', async () => {
  const prisma = createPrismaMock();
  await seedVehicles(prisma);

  const expected = [
    ['NDG 5821', 'garage-marikina'],
    ['CAK 9043', 'garage-sta-rosa'],
    ['WOB 2947', 'garage-pulilan'],
    ['PXW 382', 'garage-marikina'],
    ['TGD 908', 'garage-sta-rosa'],
    ['NRE 471', 'garage-pulilan'],
  ];
  assert.equal(prisma.upserts.length, expected.length);
  for (const [index, [plateNumber, garageId]] of expected.entries()) {
    assert.equal(prisma.upserts[index].where.plateNumber, plateNumber);
    assert.deepEqual(prisma.upserts[index].update, {});
    assert.equal(prisma.upserts[index].create.garageId, garageId);
    assert.ok(prisma.upserts[index].create.id);
  }
  assert.equal(prisma.auditRows.length, 18);
  for (const plate of expected.map(([plateNumber]) => plateNumber)) {
    const history = prisma.auditRows.filter((row) =>
      prisma.upserts.some(
        (upsert) =>
          upsert.where.plateNumber === plate &&
          upsert.create.id === row.vehicleId,
      ),
    );
    assert.equal(history.length, 3);
    assert.ok(Number(history[0].newValue) < Number(history[1].newValue));
    assert.ok(Number(history[1].newValue) < Number(history[2].newValue));
  }
});

test('seed does not add synthetic history to existing vehicles', async () => {
  const existingVehicles = [
    { id: 'existing-id', plateNumber: 'NDG 5821', odometer: 120000 },
  ];
  const prisma = createPrismaMock(branches, existingVehicles);
  await seedVehicles(prisma);

  assert.equal(
    prisma.auditRows.filter((row) => row.vehicleId === 'existing-id').length,
    0,
  );
  assert.deepEqual(prisma.upserts[0].update, {});
});

test('seed fails before writing vehicles when a required branch is missing', async () => {
  const prisma = createPrismaMock(branches.slice(0, 2));
  await assert.rejects(
    seedVehicles(prisma),
    /registered garage branch "Pulilan" is missing/,
  );
  assert.equal(prisma.upserts.length, 0);
});
