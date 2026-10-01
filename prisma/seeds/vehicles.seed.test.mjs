import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedVehicles } from './vehicles.seed.ts';

const branches = [
  { id: 'garage-marikina', name: 'Marikina' },
  { id: 'garage-sta-rosa', name: 'Sta. Rosa' },
  { id: 'garage-pulilan', name: 'Pulilan' },
];

function createPrismaMock(garages = branches) {
  const upserts = [];
  return {
    upserts,
    garage: { findMany: async () => garages },
    vehicle: {
      upsert: async (args) => {
        upserts.push(args);
        return args.create;
      },
    },
  };
}

test('seeded vehicles receive registered garage IDs on create and rerun', async () => {
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
    assert.equal(prisma.upserts[index].update.garageId, garageId);
    assert.equal(prisma.upserts[index].create.garageId, garageId);
  }
});

test('seed fails before writing vehicles when a required branch is missing', async () => {
  const prisma = createPrismaMock(branches.slice(0, 2));
  await assert.rejects(
    seedVehicles(prisma),
    /registered garage branch "Pulilan" is missing/,
  );
  assert.equal(prisma.upserts.length, 0);
});
