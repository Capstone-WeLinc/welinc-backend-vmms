import {
  MaintenanceCancellationReviewStatus,
  MaintenanceScheduleExtensionAuditEventType,
  MaintenanceScheduleExtensionReviewStatus,
  MaintenanceScheduleRescheduleSource,
  MaintenanceStatus,
  Prisma,
  PrismaClient,
  VehicleStatus,
} from '@prisma/client';
import { isFuelEfficiencyAnomaly } from '../../src/modules/vmms/fuel/fuel-math';
import { suiteSeedPeople } from './users.seed';
import { seedId } from './seed-id';

const demoPlates = [
  'NDG 5821',
  'CAK 9043',
  'WOB 2947',
  'PXW 382',
  'TGD 908',
  'NRE 471',
];
const demoFuelAnomalyThresholdPercent = 20;
const demoMaintenanceCostThreshold = 4000;

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

function dateOnlyDaysAgo(days: number): Date {
  const date = daysAgo(days);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function manilaDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as {
    year: string;
    month: string;
    day: string;
  };
}

export async function seedRelationalDemoData(
  prisma: PrismaClient,
): Promise<void> {
  const people = suiteSeedPeople();
  const operationsSeed = people.find(
    (person) =>
      person.state === 'active' &&
      person.roles.some(
        (role) => role.system === 'VMMS' && role.role === 'OPERATIONS',
      ),
  );
  const adminSeed = people.find(
    (person) =>
      person.state === 'active' &&
      person.roles.some(
        (role) => role.system === 'VMMS' && role.role === 'ADMIN',
      ),
  );
  if (!operationsSeed || !adminSeed) {
    throw new Error(
      'Cannot seed relational demo records without active VMMS Operations and Admin identities.',
    );
  }
  const seedPeople = await prisma.vmmsPerson.findMany({
    where: {
      authUserId: { in: [operationsSeed.id, adminSeed.id] },
      isActive: true,
      deleted: false,
      erased: false,
    },
  });
  const hasActiveRole = (
    person: (typeof seedPeople)[number] | undefined,
    role: 'OPERATIONS' | 'ADMIN',
  ) =>
    Boolean(
      person?.roles.includes(role) && !person.temporaryRoles.includes(role),
    );
  const operations = seedPeople.find(
    (person) => person.authUserId === operationsSeed.id,
  );
  const admin = seedPeople.find((person) => person.authUserId === adminSeed.id);
  if (
    !operations ||
    !admin ||
    !hasActiveRole(operations, 'OPERATIONS') ||
    !hasActiveRole(admin, 'ADMIN')
  ) {
    throw new Error(
      'Cannot seed relational demo records: active local VMMS Operations and Admin identities are required.',
    );
  }

  const vehicles = await prisma.vehicle.findMany({
    where: { plateNumber: { in: demoPlates }, isActive: true, deletedAt: null },
    select: {
      id: true,
      plateNumber: true,
      odometer: true,
    },
  });
  const vehiclesByPlate = new Map(
    vehicles.map((vehicle) => [vehicle.plateNumber, vehicle]),
  );
  const missingVehicle = demoPlates.find(
    (plate) => !vehiclesByPlate.has(plate),
  );
  if (missingVehicle) {
    throw new Error(
      `Cannot seed relational demo records: active vehicle "${missingVehicle}" is missing.`,
    );
  }

  const scheduleIdentities = [
    'ndg-oil-change-history',
    'cak-brake-inspection-in-progress',
    'wob-brake-inspection-odometer-overdue',
    'pxw-general-inspection-cancelled',
    'nre-brake-inspection-upcoming',
  ];
  const scheduleIds = scheduleIdentities.map((identity) =>
    seedId(`schedule:${identity}`),
  );
  const schedules = await prisma.maintenanceSchedule.findMany({
    where: { id: { in: scheduleIds } },
  });
  const schedulesByIdentity = new Map(
    scheduleIdentities
      .map((identity, index) => {
        const schedule = schedules.find(
          (entry) => entry.id === scheduleIds[index],
        );
        return schedule ? ([identity, schedule] as const) : null;
      })
      .filter(
        (entry): entry is readonly [string, (typeof schedules)[number]] =>
          entry !== null,
      ),
  );
  const requiredSchedule = (identity: string) => {
    const schedule = schedulesByIdentity.get(identity);
    if (!schedule) {
      throw new Error(
        `Cannot seed relational demo records: maintenance fixture "${identity}" is missing.`,
      );
    }
    return schedule;
  };

  await prisma.directorySyncState.upsert({
    where: { id: 'auth' },
    update: {},
    create: { id: 'auth' },
  });

  const stationName = 'VMMS Demo Fuel Station';
  const stationId = seedId('fuel-station:vmms-demo');
  const existingStation = await prisma.fuelStation.findUnique({
    where: { name: stationName },
  });
  if (existingStation && existingStation.id !== stationId) {
    throw new Error(
      `Cannot seed fuel demo records: station "${stationName}" exists but is not owned by this seed.`,
    );
  }
  const station = await prisma.fuelStation.upsert({
    where: { id: stationId },
    update: { name: stationName, isActive: true },
    create: {
      id: stationId,
      name: stationName,
      isActive: true,
    },
  });

  const fuelAnomalySetting = await prisma.$transaction(async (tx) => {
    const previousFuelSetting = await tx.fuelAnomalySetting.findUnique({
      where: { id: 'default' },
    });
    const fuelThreshold =
      previousFuelSetting == null
        ? null
        : Number(previousFuelSetting.thresholdPercent);
    const fuelAnomalySetting =
      fuelThreshold === demoFuelAnomalyThresholdPercent
        ? previousFuelSetting
        : await tx.fuelAnomalySetting.upsert({
            where: { id: 'default' },
            update: {
              thresholdPercent: demoFuelAnomalyThresholdPercent,
              updatedById: admin.authUserId,
              updatedByEmail: admin.email.toLowerCase(),
            },
            create: {
              id: 'default',
              thresholdPercent: demoFuelAnomalyThresholdPercent,
              updatedById: admin.authUserId,
              updatedByEmail: admin.email.toLowerCase(),
            },
          });
    if (fuelThreshold !== demoFuelAnomalyThresholdPercent) {
      await tx.fuelAnomalyThresholdAudit.create({
        data: {
          actorId: admin.authUserId,
          actorEmail: admin.email.toLowerCase(),
          previousThreshold: previousFuelSetting?.thresholdPercent ?? null,
          newThreshold: demoFuelAnomalyThresholdPercent,
        },
      });
    }

    const previousCostingSetting =
      await tx.maintenanceCostingSetting.findUnique({
        where: { id: 'default' },
      });
    const costingThreshold =
      previousCostingSetting?.threshold == null
        ? null
        : Number(previousCostingSetting.threshold);
    if (costingThreshold !== demoMaintenanceCostThreshold) {
      await tx.maintenanceCostingSetting.upsert({
        where: { id: 'default' },
        update: {
          threshold: demoMaintenanceCostThreshold,
          updatedById: admin.authUserId,
          updatedByEmail: admin.email.toLowerCase(),
        },
        create: {
          id: 'default',
          threshold: demoMaintenanceCostThreshold,
          updatedById: admin.authUserId,
          updatedByEmail: admin.email.toLowerCase(),
        },
      });
      await tx.maintenanceCostingThresholdAudit.create({
        data: {
          actorId: admin.authUserId,
          actorEmail: admin.email.toLowerCase(),
          previousThreshold: previousCostingSetting?.threshold ?? null,
          newThreshold: demoMaintenanceCostThreshold,
        },
      });
    }

    return fuelAnomalySetting;
  });
  if (!fuelAnomalySetting) {
    throw new Error(
      'Cannot seed relational demo records: fuel anomaly threshold was not saved.',
    );
  }

  const vehicleAuditRows = vehicles.flatMap((vehicle) =>
    [60, 30, 0].map((days, index) => ({
      id: seedId(`odometer:${vehicle.plateNumber}:${index}`),
      vehicleId: vehicle.id,
      userId: operations.authUserId,
      email: operations.email.toLowerCase(),
      action: 'ODOMETER_UPDATED',
      fieldName: 'odometer',
      previousValue: String(vehicle.odometer - (3 - index) * 3000),
      newValue: String(vehicle.odometer - (2 - index) * 3000),
      createdAt: daysAgo(days),
    })),
  );
  await prisma.vehicleAuditLog.createMany({
    data: vehicleAuditRows,
    skipDuplicates: true,
  });

  const templates = await prisma.checklistTemplate.findMany({
    where: {
      type: {
        in: [
          'Oil Change',
          'Brake Inspection',
          'Engine Tune-up',
          'Tire Rotation',
          'General Inspection',
        ],
      },
      deletedAt: null,
    },
    select: { id: true, type: true },
  });
  const requiredTemplateTypes = [
    'Oil Change',
    'Brake Inspection',
    'Engine Tune-up',
    'Tire Rotation',
    'General Inspection',
  ];
  const availableTemplateTypes = new Set(templates.map(({ type }) => type));
  const missingTemplate = requiredTemplateTypes.find(
    (type) => !availableTemplateTypes.has(type),
  );
  if (missingTemplate) {
    throw new Error(
      `Cannot seed vehicle maintenance defaults: checklist template "${missingTemplate}" is missing.`,
    );
  }
  const templateIntervals: Record<string, [number, number]> = {
    'Oil Change': [5000, 500],
    'Brake Inspection': [10000, 1000],
    'Engine Tune-up': [15000, 1000],
    'Tire Rotation': [8000, 500],
    'General Inspection': [12000, 1000],
  };
  const maintenanceDefaults = vehicles.flatMap((vehicle) =>
    templates.map((template) => ({
      vehicleId: vehicle.id,
      checklistTemplateId: template.id,
      intervalKm: templateIntervals[template.type][0],
      bufferDistanceKm: templateIntervals[template.type][1],
    })),
  );
  await prisma.vehicleMaintenanceDefault.createMany({
    data: maintenanceDefaults,
    skipDuplicates: true,
  });

  const cancelledSchedule = requiredSchedule(
    'pxw-general-inspection-cancelled',
  );
  await prisma.maintenanceScheduleCancellation.createMany({
    data: [
      {
        id: seedId('schedule-cancellation:pxw-general-inspection'),
        scheduleId: cancelledSchedule.id,
        actorId: operations.authUserId,
        actorName: operations.name,
        actorEmail: operations.email.toLowerCase(),
        reason: 'Synthetic cancellation fixture for workflow testing.',
        previousStatus: MaintenanceStatus.PENDING,
        reviewStatus: MaintenanceCancellationReviewStatus.APPROVED,
        reviewedById: admin.authUserId,
        reviewedByName: admin.name,
        reviewedByEmail: admin.email.toLowerCase(),
        reviewReason: 'Synthetic demo approval.',
        reviewedAt: daysAgo(29),
        createdAt: daysAgo(30),
      },
    ],
    skipDuplicates: true,
  });

  const activeSchedule = requiredSchedule('cak-brake-inspection-in-progress');
  const extensionId = seedId('schedule-extension:cak-brake-inspection');
  const extensionRequestedDate = new Date(
    (activeSchedule.targetDueDate ?? dateOnlyDaysAgo(-7)).getTime() +
      7 * 24 * 60 * 60 * 1000,
  );
  const extensionData = {
    scheduleId: activeSchedule.id,
    actorId: operations.authUserId,
    actorName: operations.name,
    actorEmail: operations.email.toLowerCase(),
    requestedDueDate: extensionRequestedDate,
    reason: 'Synthetic extension request for workflow testing.',
    reviewStatus: MaintenanceScheduleExtensionReviewStatus.PENDING,
    reviewedById: null,
    reviewedByName: null,
    reviewedByEmail: null,
    reviewReason: null,
    reviewedAt: null,
    createdAt: daysAgo(2),
  };
  const extension = await prisma.maintenanceScheduleExtension.upsert({
    where: { id: extensionId },
    update: extensionData,
    create: {
      id: extensionId,
      ...extensionData,
    },
  });
  await prisma.maintenanceScheduleExtensionAudit.createMany({
    data: [
      {
        id: seedId('schedule-extension-audit:cak-requested'),
        scheduleId: activeSchedule.id,
        extensionId: extension.id,
        eventType: MaintenanceScheduleExtensionAuditEventType.REQUESTED,
        actorId: operations.authUserId,
        actorName: operations.name,
        actorEmail: operations.email.toLowerCase(),
        previousDueDate: activeSchedule.targetDueDate,
        requestedDueDate: extension.requestedDueDate,
        reason: extension.reason,
        recordedAt: daysAgo(2),
      },
    ],
    skipDuplicates: true,
  });

  const completedSchedule = requiredSchedule('ndg-oil-change-history');
  const newTargetDueDate = activeSchedule.targetDueDate ?? dateOnlyDaysAgo(-7);
  const previousTargetDueDate = new Date(
    newTargetDueDate.getTime() - 7 * 24 * 60 * 60 * 1000,
  );
  await prisma.maintenanceScheduleRescheduleAudit.createMany({
    data: [
      {
        id: seedId('schedule-reschedule-audit:cak-brake-inspection'),
        scheduleId: activeSchedule.id,
        source: MaintenanceScheduleRescheduleSource.MANUAL_UPDATE,
        actorId: operations.authUserId,
        actorName: operations.name,
        actorEmail: operations.email.toLowerCase(),
        previousStartDate: activeSchedule.startDate,
        newStartDate: activeSchedule.startDate,
        previousTargetDueDate,
        newTargetDueDate,
        changedAt: daysAgo(4),
      },
    ],
    skipDuplicates: true,
  });

  const unlockId = seedId('maintenance-log-edit-unlock:ndg-oil-change');
  const unlockData = {
    scheduleId: completedSchedule.id,
    actorId: operations.authUserId,
    actorName: operations.name,
    actorEmail: operations.email.toLowerCase(),
    reason: 'Synthetic approved log correction fixture.',
    reviewStatus: MaintenanceCancellationReviewStatus.APPROVED,
    reviewedById: admin.authUserId,
    reviewedByName: admin.name,
    reviewedByEmail: admin.email.toLowerCase(),
    reviewReason: 'Synthetic demo approval.',
    reviewedAt: daysAgo(39),
    activatedAt: daysAgo(39),
    createdAt: daysAgo(40),
    consumedAt: daysAgo(38),
  };
  const unlock = await prisma.maintenanceLogEditUnlock.upsert({
    where: { id: unlockId },
    update: unlockData,
    create: {
      id: unlockId,
      ...unlockData,
    },
  });
  await prisma.maintenanceLogEditAudit.createMany({
    data: [
      {
        id: seedId('maintenance-log-edit-audit:ndg-oil-change'),
        scheduleId: completedSchedule.id,
        unlockId: unlock.id,
        actorId: operations.authUserId,
        actorName: operations.name,
        actorEmail: operations.email.toLowerCase(),
        unlockReason: unlock.reason,
        fieldName: 'maintenanceRemarks',
        previousValue: 'Synthetic original service remarks.',
        newValue: 'Synthetic corrected service remarks.',
        changedAt: daysAgo(38),
      },
    ],
    skipDuplicates: true,
  });

  const assignedSchedule = schedulesByIdentity.get(
    'nre-brake-inspection-upcoming',
  );
  if (assignedSchedule?.assignedMechanicId) {
    await prisma.maintenanceNotification.upsert({
      where: { id: seedId('maintenance-notification:nre-brake-created') },
      update: {
        userId: assignedSchedule.assignedMechanicId,
        scheduleId: assignedSchedule.id,
        kind: 'CREATED',
        message: `A maintenance work order has been assigned to you: ${assignedSchedule.title} (${assignedSchedule.vehicleId}).`,
        readAt: null,
      },
      create: {
        id: seedId('maintenance-notification:nre-brake-created'),
        userId: assignedSchedule.assignedMechanicId,
        scheduleId: assignedSchedule.id,
        kind: 'CREATED',
        message: `A maintenance work order has been assigned to you: ${assignedSchedule.title} (${assignedSchedule.vehicleId}).`,
      },
    });
  }

  const fuelVehicle = vehiclesByPlate.get('TGD 908');
  if (!fuelVehicle) {
    throw new Error(
      'Cannot seed fuel demo records: vehicle TGD 908 is missing.',
    );
  }
  if (fuelVehicle.odometer <= 4000) {
    throw new Error(
      'Cannot seed fuel demo records: vehicle TGD 908 needs an odometer reading above 4,000 km.',
    );
  }
  const firstFuelOdometer = fuelVehicle.odometer - 4000;
  const fuelFillUps = [0, 1, 2, 3].map((index) => {
    const liters = [100, 100, 100, 400];
    const date = dateOnlyDaysAgo(120 - index * 30);
    const id = seedId(`fuel-fill-up:tgd-demo:${index + 1}`);
    return {
      id,
      vehicleId: fuelVehicle.id,
      stationId: station.id,
      stationNameSnapshot: station.name,
      filledBy: 'Synthetic fleet operator',
      enteredById: operations.authUserId,
      entryDate: date,
      liters: liters[index],
      pricePerLiter: 60.5,
      totalCost: liters[index] * 60.5,
      poNumber: `DEMO-PO-${index + 1}`,
      siNumber: `DEMO-SI-${index + 1}`,
      product: 'Diesel',
      odometer: firstFuelOdometer + index * 1000,
      isFullTank: true,
      isVoided: false,
      voidReason: null,
      voidedById: null,
      voidedAt: null,
      createdAt: daysAgo(120 - index * 30),
    };
  });
  await Promise.all(
    fuelFillUps.map(({ id, ...data }) =>
      prisma.fuelFillUp.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      }),
    ),
  );
  const fuelAuditRows = fuelFillUps.map((fillUp, index) => ({
    id: seedId(`fuel-audit-log:tgd-demo:${index + 1}`),
    fillUpId: fillUp.id,
    actorId: operations.authUserId,
    actorEmail: operations.email.toLowerCase(),
    action: 'CREATED',
    details: { syntheticSeed: true } satisfies Prisma.InputJsonValue,
    createdAt: fillUp.createdAt,
  }));
  await prisma.fuelAuditLog.createMany({
    data: fuelAuditRows,
    skipDuplicates: true,
  });

  const anomalyFillUp = fuelFillUps[fuelFillUps.length - 1];
  const hasSyntheticFuelAnomaly = isFuelEfficiencyAnomaly(
    2.5,
    10,
    Number(fuelAnomalySetting.thresholdPercent),
  );
  if (hasSyntheticFuelAnomaly) {
    const anomalyId = seedId('fuel-anomaly:tgd-demo');
    const anomalyData = {
      fillUpId: anomalyFillUp.id,
      vehicleId: fuelVehicle.id,
      efficiency: 2.5,
      rollingAverage: 10,
      status: 'OPEN',
      note: null,
      notedAt: null,
      notedById: null,
      acknowledgedAt: null,
      acknowledgedById: null,
      acknowledgment: null,
      resolvedAt: null,
      resolvedById: null,
      notifiedDay1At: null,
      notifiedDay3At: null,
      notifiedDay7At: null,
      createdAt: anomalyFillUp.createdAt,
    };
    await prisma.fuelAnomaly.upsert({
      where: { id: anomalyId },
      create: { id: anomalyId, ...anomalyData },
      update: anomalyData,
    });
  }

  const draftRows: Prisma.InputJsonValue[] = [
    {
      key: 'demo-row-1',
      sheetName: 'Fuel Log',
      worksheetRow: 2,
      plateNumber: fuelVehicle.plateNumber,
      date: daysAgo(1).toISOString().slice(0, 10),
      odometer: fuelVehicle.odometer,
      poNumber: 'DEMO-IMPORT-PO',
      siNumber: 'DEMO-IMPORT-SI',
      product: 'Diesel',
      liters: 100,
      pricePerLiter: 60.5,
      vehicleId: fuelVehicle.id,
      stationId: station.id,
      filledBy: 'Synthetic fleet operator',
      isFullTank: true,
      errors: [],
      status: 'READY',
    },
  ];
  await prisma.fuelImportDraft.upsert({
    where: { id: seedId('fuel-import-draft:demo') },
    update: {
      ownerAuthUserId: operations.authUserId,
      sourceName: 'VMMS synthetic fuel import.xlsx',
      rows: draftRows,
    },
    create: {
      id: seedId('fuel-import-draft:demo'),
      ownerAuthUserId: operations.authUserId,
      sourceName: 'VMMS synthetic fuel import.xlsx',
      rows: draftRows,
    },
  });

  await prisma.maintenanceCostingExportAudit.createMany({
    data: [
      {
        id: seedId('maintenance-costing-export-audit:demo'),
        actorId: admin.authUserId,
        actorEmail: admin.email.toLowerCase(),
        format: 'XLSX',
        fromDate: dateOnlyDaysAgo(90),
        toDate: dateOnlyDaysAgo(0),
        selectedTruckId: fuelVehicle.id,
        selectedTruckPlate: fuelVehicle.plateNumber,
        createdAt: daysAgo(1),
      },
    ],
    skipDuplicates: true,
  });

  const manila = manilaDateParts(new Date());
  const dailyPeriod = `${manila.year}-${manila.month}-${manila.day}`;
  const monthDate = new Date(
    Date.UTC(Number(manila.year), Number(manila.month) - 2, 1),
  );
  const monthlyPeriod = `${monthDate.getUTCFullYear()}-${String(
    monthDate.getUTCMonth() + 1,
  ).padStart(2, '0')}`;
  const [
    overdueWorkOrders,
    vehiclesUnderMaintenance,
    openFuelAnomalies,
    maintenanceCosts,
    fuelCosts,
  ] = await Promise.all([
    prisma.maintenanceSchedule.count({
      where: { deletedAt: null, status: MaintenanceStatus.OVERDUE },
    }),
    prisma.vehicle.count({
      where: {
        deletedAt: null,
        status: {
          in: [VehicleStatus.UNDER_MAINTENANCE, VehicleStatus.UNDER_REPAIR],
        },
      },
    }),
    prisma.fuelAnomaly.count({
      where: { status: 'OPEN', fillUp: { isVoided: false } },
    }),
    prisma.maintenanceSchedule.aggregate({
      where: {
        deletedAt: null,
        status: MaintenanceStatus.COMPLETED,
        completedAt: {
          gte: new Date(
            Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1),
          ),
          lt: new Date(
            Date.UTC(
              monthDate.getUTCFullYear(),
              monthDate.getUTCMonth() + 1,
              1,
            ),
          ),
        },
      },
      _sum: { partsCost: true, laborCost: true, totalCost: true },
    }),
    prisma.fuelFillUp.aggregate({
      where: {
        isVoided: false,
        entryDate: {
          gte: new Date(
            Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1),
          ),
          lt: new Date(
            Date.UTC(
              monthDate.getUTCFullYear(),
              monthDate.getUTCMonth() + 1,
              1,
            ),
          ),
        },
      },
      _sum: { totalCost: true },
    }),
  ]);
  const dailyData: Prisma.InputJsonValue = {
    overdueWorkOrders,
    vehiclesUnderMaintenance,
    openFuelAnomalies,
  };
  const monthlyData: Prisma.InputJsonValue = {
    period: monthlyPeriod,
    currency: 'PHP',
    maintenancePartsCost: maintenanceCosts._sum.partsCost?.toString() ?? '0.00',
    maintenanceLaborCost: maintenanceCosts._sum.laborCost?.toString() ?? '0.00',
    maintenanceTotalCost: maintenanceCosts._sum.totalCost?.toString() ?? '0.00',
    fuelTotalCost: fuelCosts._sum.totalCost?.toString() ?? '0.00',
  };
  const reportRows = [
    {
      id: seedId(`scheduled-fleet-report:daily:${dailyPeriod}`),
      reportType: 'daily-operations',
      periodKey: dailyPeriod,
      data: dailyData,
      generatedAt: daysAgo(0),
    },
    {
      id: seedId(`scheduled-fleet-report:monthly:${monthlyPeriod}`),
      reportType: 'monthly-costs',
      periodKey: monthlyPeriod,
      data: monthlyData,
      generatedAt: daysAgo(0),
    },
  ];
  await Promise.all(
    reportRows.map(({ id, ...data }) =>
      prisma.scheduledFleetReport.upsert({
        where: { id },
        create: { id, ...data },
        update: data,
      }),
    ),
  );

  const notifications = [
    ...(hasSyntheticFuelAnomaly
      ? [
          {
            id: seedId('notification:fuel-anomaly:demo'),
            userId: operations.authUserId,
            title: 'Fuel efficiency anomaly',
            message: `${fuelVehicle.plateNumber} has a synthetic fuel-efficiency anomaly fixture.`,
            type: 'warning',
            dedupeKey: 'vmms-demo:fuel-anomaly',
          },
        ]
      : []),
    {
      id: seedId('notification:maintenance:overdue-demo'),
      userId: admin.authUserId,
      title: 'Maintenance overdue follow-up',
      message: `Synthetic overdue maintenance fixture: ${requiredSchedule('wob-brake-inspection-odometer-overdue').workOrderNumber}.`,
      type: 'warning',
      dedupeKey: 'vmms-demo:maintenance-overdue',
      maintenanceScheduleId: requiredSchedule(
        'wob-brake-inspection-odometer-overdue',
      ).id,
    },
  ];
  await Promise.all(
    notifications.map(({ id, ...data }) =>
      prisma.notification.upsert({
        where: { id },
        create: { id, ...data },
        update: { ...data, isRead: false },
      }),
    ),
  );
}
