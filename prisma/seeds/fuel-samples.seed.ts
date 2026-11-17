import { PrismaClient } from '@prisma/client';

const DEMO_DRIVER = 'Sample Driver (Demo Data)';
const DEMO_NOTIFICATION_PREFIX = '[FUEL_DEMO]';

/** Creates repeatable demo records for the outline's fuel screens and workflows. */
export async function seedFuelSamples(
  prisma: PrismaClient,
  options: { fromStandardSeed?: boolean } = {},
) {
  if (process.env['NODE_ENV'] === 'production' || (!options.fromStandardSeed && process.env['FUEL_DEMO_SEED'] !== 'true')) {
    throw new Error('Fuel demo data is development-only. Set FUEL_DEMO_SEED=true and do not run against production.');
  }
  const operator = await prisma.vmmsPerson.findFirst({ where: { roles: { has: 'OPERATIONS' }, isActive: true, deleted: false } });
  if (!operator) throw new Error('Fuel sample seed requires a directory-synced VMMS Operations person.');

  const stationNames = ['Petron', 'Shell', 'Sea Oil'];
  const stations = await Promise.all(stationNames.map((name) => prisma.fuelStation.upsert({
    where: { name }, update: { isActive: true }, create: { name },
  })));
  const vehicles = await prisma.vehicle.findMany({
    where: { plateNumber: { in: ['NDG 5821', 'CAK 9043', 'WOB 2947'] }, deletedAt: null, isActive: true },
    orderBy: { plateNumber: 'asc' },
  });
  if (vehicles.length !== 3) throw new Error('Fuel sample seed requires the three standard sample vehicles. Run the standard VMMS seed first.');

  const roles = ['ADMIN', 'OPERATIONS', 'CHIEF_MECHANIC'];
  const recipients = await prisma.vmmsPerson.findMany({
    where: { isActive: true, deleted: false, roles: { hasSome: roles } },
    select: { authUserId: true, roles: true, temporaryRoles: true },
  });
  if (!recipients.some((user) => user.authUserId === operator.authUserId && user.roles.some((role) => role === 'OPERATIONS' && !user.temporaryRoles.includes(role)))) throw new Error('The Operations sample user must have an active permanent VMMS Operations role.');

  const dateParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  const today = new Date(`${values['year']}-${values['month']}-${values['day']}T00:00:00.000Z`);
  const dateAt = (daysAgo: number) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return date;
  };

  await prisma.$transaction(async (tx) => {
    // Remove only this seed's own records so rerunning it is safe and never
    // deletes real fuel history, audit entries, or user notifications.
    const priorRows = await tx.fuelFillUp.findMany({ where: { filledBy: DEMO_DRIVER }, select: { id: true } });
    const priorIds = priorRows.map((row) => row.id);
    if (priorIds.length) {
      const anomalies = await tx.fuelAnomaly.findMany({ where: { fillUpId: { in: priorIds } }, select: { id: true } });
      const anomalyIds = anomalies.map((row) => row.id);
      if (anomalyIds.length) await tx.fuelAnomalyAttachment.deleteMany({ where: { anomalyId: { in: anomalyIds } } });
      await tx.fuelAnomaly.deleteMany({ where: { fillUpId: { in: priorIds } } });
      await tx.fuelAuditLog.deleteMany({ where: { fillUpId: { in: priorIds } } });
      await tx.fuelFillUp.deleteMany({ where: { id: { in: priorIds } } });
    }
    await tx.notification.deleteMany({ where: { message: { startsWith: DEMO_NOTIFICATION_PREFIX } } });

    const seeded: Array<{ id: string; vehicleId: string; date: Date; odometer: number; liters: number; stationId: string; isFullTank: boolean; anomalyCandidate: boolean; isVoided: boolean }> = [];
    for (const [vehicleIndex, vehicle] of vehicles.entries()) {
      const latestReal = await tx.fuelFillUp.findFirst({ where: { vehicleId: vehicle.id, filledBy: { not: DEMO_DRIVER } }, orderBy: [{ odometer: 'desc' }, { createdAt: 'desc' }], select: { odometer: true } });
      const baseOdometer = Math.max(vehicle.odometer, latestReal?.odometer ?? 0);
      const cycles = vehicleIndex === 0 ? [40, 30, 20, 10] : [30, 15, 1];
      let previousOdometer = baseOdometer;
      for (const [cycleIndex, daysAgo] of cycles.entries()) {
        const odometer = baseOdometer + (cycleIndex + 1) * 1000;
        // Three consistent cycles establish the baseline. The first truck's
        // fourth cycle is deliberately inefficient to exercise anomaly views.
        const liters = vehicleIndex === 0 && cycleIndex === 3 ? 180 : 100;
        const date = dateAt(daysAgo);
        const row = await tx.fuelFillUp.create({ data: {
          vehicleId: vehicle.id,
          stationId: stations[(vehicleIndex + cycleIndex) % stations.length].id,
          filledBy: DEMO_DRIVER,
          enteredById: operator.authUserId,
          entryDate: date,
          createdAt: date,
          liters,
          pricePerLiter: 62.5 + vehicleIndex,
          totalCost: Math.round(liters * (62.5 + vehicleIndex) * 100) / 100,
          odometer,
          isFullTank: true,
        } });
        seeded.push({ id: row.id, vehicleId: vehicle.id, date, odometer, liters, stationId: row.stationId, isFullTank: true, anomalyCandidate: vehicleIndex === 0 && cycleIndex === 3, isVoided: false });
        previousOdometer = odometer;
      }

      // Keep a partial receipt in cost/history views. One is voided below to
      // demonstrate retained audit history and exclusion from totals.
      const partialDate = dateAt(0);
      const partial = await tx.fuelFillUp.create({ data: {
        vehicleId: vehicle.id,
        stationId: stations[vehicleIndex % stations.length].id,
        filledBy: DEMO_DRIVER,
        enteredById: operator.authUserId,
        entryDate: partialDate,
        createdAt: partialDate,
        liters: 35 + vehicleIndex * 5,
        pricePerLiter: 63 + vehicleIndex,
        totalCost: (35 + vehicleIndex * 5) * (63 + vehicleIndex),
        odometer: previousOdometer,
        isFullTank: false,
        ...(vehicleIndex === 2 ? { isVoided: true, voidReason: 'Demo record to show void handling.', voidedById: operator.authUserId, voidedAt: new Date() } : {}),
      } });
      seeded.push({ id: partial.id, vehicleId: vehicle.id, date: partialDate, odometer: previousOdometer, liters: 35 + vehicleIndex * 5, stationId: partial.stationId, isFullTank: false, anomalyCandidate: false, isVoided: vehicleIndex === 2 });
    }

    for (const row of seeded) {
      await tx.fuelAuditLog.create({ data: { fillUpId: row.id, actorId: operator.authUserId, actorEmail: operator.email, action: 'CREATED', details: { demoSeed: true } } });
      if (row.isVoided) await tx.fuelAuditLog.create({ data: { fillUpId: row.id, actorId: operator.authUserId, actorEmail: operator.email, action: 'VOIDED', reason: 'Demo record to show void handling.' } });
    }

    const anomalyRow = seeded.find((row) => row.anomalyCandidate);
    if (!anomalyRow) throw new Error('Fuel demo seed did not create its anomaly sample.');
    const rollingAverage = 10;
    const efficiency = Math.round(((anomalyRow.odometer - (anomalyRow.odometer - 1000)) / anomalyRow.liters) * 100) / 100;
    const setting = await tx.fuelAnomalySetting.findUnique({ where: { id: 'default' } });
    const thresholdPercent = Number(setting?.thresholdPercent ?? 20);
    let anomalyId: string | null = null;
    if (efficiency < rollingAverage * (1 - thresholdPercent / 100)) {
      const anomalyCreatedAt = anomalyRow.date;
      const anomaly = await tx.fuelAnomaly.create({ data: {
        fillUpId: anomalyRow.id,
        vehicleId: anomalyRow.vehicleId,
        efficiency,
        rollingAverage,
        note: 'Demo anomaly: review the receipt and add a resolution note.',
        createdAt: anomalyCreatedAt,
        notifiedDay1At: dateAt(9),
        notifiedDay3At: dateAt(7),
        notifiedDay7At: dateAt(3),
      } });
      anomalyId = anomaly.id;
      for (const recipient of recipients) {
        await tx.notification.create({ data: {
          userId: recipient.authUserId,
          title: 'Fuel efficiency anomaly',
          message: `${DEMO_NOTIFICATION_PREFIX} NDG 5821 recorded ${efficiency.toFixed(1)} km/L versus its ${rollingAverage.toFixed(1)} km/L rolling average.`,
          type: 'warning',
          createdAt: anomalyCreatedAt,
        } });
      }
    }
    const anomalySummary = anomalyId ? `open critical anomaly, notifications (threshold ${thresholdPercent}%)` : `no anomaly sample because the configured ${thresholdPercent}% threshold is stricter than this sample`;
    console.log(`Fuel demo data ready: ${seeded.length} entries across ${vehicles.length} vehicles, with full-tank efficiency baselines, ${anomalySummary}, report/filter history, and an audited void sample.`);
  });
}
