import { stateForStorage } from '../../src/modules/vmms/maintenance-schedules/work-order-state';
import {
  addTimeInterval,
  getTimeInterval,
} from '../../src/modules/vmms/maintenance-schedules/time-interval';
import {
  Prisma,
  PrismaClient,
  MaintenanceStatus,
  MaintenanceApprovalStatus,
  MaintenancePriority,
  AccountType,
  MaintenanceTriggerType,
  MaintenanceIntervalType,
} from '@prisma/client';
import { seedId } from './seed-id';

function reconcileSeedOdometerReading(
  fixtureReading: number | null | undefined,
  vehicleOdometer: number,
): number | null | undefined {
  return fixtureReading == null
    ? fixtureReading
    : Math.min(fixtureReading, vehicleOdometer);
}

export async function seedVmms(prisma: PrismaClient) {
  console.log('Ensuring checklist templates for VMMS...');

  // Fetch relations from DB
  const garages = await prisma.garage.findMany({
    where: { isActive: true, deletedAt: null },
    orderBy: { name: 'asc' },
  });
  const seededVehiclePlates = [
    'NDG 5821',
    'CAK 9043',
    'WOB 2947',
    'PXW 382',
    'TGD 908',
    'NRE 471',
  ];
  const vehicleRows = await prisma.vehicle.findMany({
    where: {
      plateNumber: { in: seededVehiclePlates },
      isActive: true,
      deletedAt: null,
    },
  });
  const vehiclesByPlate = new Map(
    vehicleRows.map((vehicle) => [vehicle.plateNumber, vehicle]),
  );
  const missingPlate = seededVehiclePlates.find(
    (plate) => !vehiclesByPlate.has(plate),
  );
  if (missingPlate) {
    throw new Error(
      `Cannot seed maintenance schedules: active sample vehicle "${missingPlate}" is missing.`,
    );
  }
  const vehicles = seededVehiclePlates.map((plate) =>
    vehiclesByPlate.get(plate)!,
  );
  const activeGarageIds = new Set(garages.map((garage) => garage.id));
  const vehicleWithoutActiveGarage = vehicles.find(
    (vehicle) => !vehicle.garageId || !activeGarageIds.has(vehicle.garageId),
  );
  if (vehicleWithoutActiveGarage) {
    throw new Error(
      `Cannot seed maintenance schedules: sample vehicle "${vehicleWithoutActiveGarage.plateNumber}" is not assigned to an active garage.`,
    );
  }
  const seededMechanicNames = [
    'Juan dela Cruz',
    'Pedro Santos',
    'Rommel Cruz',
    'Isabel Reyes',
    'Carl Santos',
  ];
  const mechanicRows = await prisma.mechanic.findMany({
    where: {
      name: { in: seededMechanicNames },
      isActive: true,
      isOutsourced: false,
    },
    orderBy: { name: 'asc' },
  });
  const mechanicsByName = new Map(
    mechanicRows.map((mechanic) => [mechanic.name, mechanic]),
  );
  const missingMechanic = seededMechanicNames.find(
    (name) => !mechanicsByName.has(name),
  );
  if (missingMechanic)
    throw new Error(
      `Cannot seed maintenance schedules: in-house mechanic "${missingMechanic}" is missing.`,
    );
  const mechanics = seededMechanicNames.map((name) =>
    mechanicsByName.get(name)!,
  );
  const sampleTargetDueDate = (schedule: any) => {
    const baseDate = new Date(
      schedule.startReferenceDate ??
        schedule.startDate ??
        schedule.createdAt ??
        new Date(),
    );
    const interval = getTimeInterval(schedule);
    return schedule.triggerType === MaintenanceTriggerType.TIME && interval
      ? addTimeInterval(baseDate, interval)
      : new Date(baseDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  };
  const chiefMechanics = await prisma.mechanic.findMany({
    where: {
      isActive: true,
      role: 'CHIEF_MECHANIC',
      isOutsourced: false,
      userId: { not: null },
    },
    orderBy: { email: 'asc' },
    select: { userId: true, name: true, email: true },
  });
  if (!chiefMechanics.length) {
    throw new Error(
      'Cannot seed maintenance schedules: no active VMMS Chief Mechanic directory rows exist.',
    );
  }

  const checklistTemplatesData = [
    {
      type: 'Oil Change',
      items: [
        'Drain old engine oil',
        'Replace oil filter',
        'Fill with new engine oil',
        'Check for oil leaks',
        'Reset maintenance light',
      ],
    },
    {
      type: 'Brake Inspection',
      items: [
        'Check brake pad thickness',
        'Inspect brake rotors for wear',
        'Check brake fluid level and condition',
        'Inspect brake lines for leaks',
        'Test brake pedal feel',
      ],
    },
    {
      type: 'Tire Rotation',
      items: [
        'Check tire pressure on all tires',
        'Inspect tire tread depth',
        'Rotate tires according to pattern',
        'Torque lug nuts to specification',
        'Check alignment if irregular wear found',
      ],
    },
    {
      type: 'Engine Tune-up',
      items: [
        'Replace spark plugs',
        'Inspect ignition coils/wires',
        'Replace air filter',
        'Clean fuel injectors (if necessary)',
        'Check engine timing and idle',
      ],
    },
    {
      type: 'General Inspection',
      items: [
        'Check all fluid levels',
        'Inspect belts and hoses',
        'Test battery and charging system',
        'Check exterior and interior lights',
        'Inspect wiper blades',
      ],
    },
  ];

  const seededTemplates: any[] = [];
  for (const templateData of checklistTemplatesData) {
    const existing = await prisma.checklistTemplate.findUnique({
      where: { type: templateData.type },
    });
    if (existing?.deletedAt)
      throw new Error(
        `Cannot seed checklist "${templateData.type}": its registered template is soft-deleted.`,
      );

    const t = await prisma.checklistTemplate.upsert({
      where: { type: templateData.type },
      update: {},
      create: {
        type: templateData.type,
      },
    });

    const existingItems = await prisma.checklistItem.findMany({
      where: { checklistTemplateId: t.id, deletedAt: null },
      select: { text: true },
    });
    const existingTexts = new Set(existingItems.map((item) => item.text));
    const missingItems = templateData.items.filter(
      (text) => !existingTexts.has(text),
    );
    if (missingItems.length) {
      await prisma.checklistItem.createMany({
        data: missingItems.map((text) => ({
          checklistTemplateId: t.id,
          text,
          order: templateData.items.indexOf(text),
        })),
        skipDuplicates: true,
      });
    }

    seededTemplates.push(t);
  }

  console.log(
    `  Processed ${seededTemplates.length} checklist templates for VMMS\n`,
  );

  console.log('Ensuring sample maintenance schedules for VMMS...');

  const resolveSeedMechanicId = (
    assignedMechanic: string,
    accountType: AccountType,
  ): string | null => {
    if (accountType === AccountType.OUTSOURCED) return null;

    const normalizedName = assignedMechanic.trim().toLowerCase();
    const matches = mechanics.filter(
      (mechanic) =>
        mechanic.name.trim().toLowerCase() === normalizedName &&
        !mechanic.isOutsourced &&
        mechanic.userId,
    );
    const userId = matches.length === 1 ? matches[0].userId : null;
    if (!userId) {
      throw new Error(
        `Seeded work order mechanic "${assignedMechanic}" must match exactly one in-house mechanic user.`,
      );
    }
    return userId;
  };

  const manilaCalendarDate = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Manila',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    if (!year || !month || !day) {
      throw new Error(
        'Cannot determine the Manila calendar date for maintenance fixtures.',
      );
    }
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  };
  const maintenanceFixtureAnchor = new Date('2026-08-25T00:00:00.000Z');
  const maintenanceFixtureOffset =
    manilaCalendarDate(new Date()).getTime() -
    maintenanceFixtureAnchor.getTime();
  const shiftMaintenanceFixtureDate = (date: Date) =>
    new Date(date.getTime() + maintenanceFixtureOffset);

  const templateByType = new Map(
    seededTemplates.map((template) => [template.type, template]),
  );
  const checklistItemsByType = new Map(
    checklistTemplatesData.map((template) => [template.type, template.items]),
  );

  const demoProviderName = 'VMMS Demo Workshop';
  const matchingDemoProviders = await prisma.outsourcedProvider.findMany({
    where: { name: { equals: demoProviderName, mode: 'insensitive' } },
    orderBy: { name: 'asc' },
  });
  if (matchingDemoProviders.length > 1) {
    throw new Error(
      `Cannot seed VMMS schedules: multiple providers match "${demoProviderName}".`,
    );
  }
  if (matchingDemoProviders[0] && !matchingDemoProviders[0].isActive) {
    throw new Error(
      `Cannot seed VMMS schedules: provider "${demoProviderName}" is inactive.`,
    );
  }
  const existingDemoProvider = matchingDemoProviders[0];

  type SeedScheduleFixture = {
    identity: string;
    vehiclePlate: string;
    title: string;
    status: MaintenanceStatus;
    priority: MaintenancePriority;
    createdDaysAgo: number;
    mechanicIndex: number;
    accountType: AccountType;
    triggerType: MaintenanceTriggerType;
    intervalKm?: number;
    bufferDistanceKm?: number;
    intervalType?: MaintenanceIntervalType;
    dueOffsetKm?: number;
    serviceOffsetKm?: number;
    timeDueInDays?: number;
    maintenanceClass?: 'REPAIR' | 'PREVENTIVE';
    progressState?: 'IN_PROGRESS' | 'SUBMITTED';
    overdueFromStatus?: MaintenanceStatus;
    partsCost?: number;
    laborCost?: number;
  };

  const scheduleFixtures: SeedScheduleFixture[] = [
    {
      identity: 'ndg-oil-change-history',
      vehiclePlate: 'NDG 5821',
      title: 'Oil Change',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 45,
      mechanicIndex: 0,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 5000,
      bufferDistanceKm: 500,
      serviceOffsetKm: 1000,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 1200,
      laborCost: 450,
    },
    {
      identity: 'cak-engine-tune-up-history',
      vehiclePlate: 'CAK 9043',
      title: 'Engine Tune-up',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 60,
      mechanicIndex: 1,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 15000,
      bufferDistanceKm: 1000,
      serviceOffsetKm: 2000,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 2400,
      laborCost: 900,
    },
    {
      identity: 'wob-oil-change-history',
      vehiclePlate: 'WOB 2947',
      title: 'Oil Change',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 35,
      mechanicIndex: 2,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 4000,
      bufferDistanceKm: 400,
      serviceOffsetKm: 1200,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 1100,
      laborCost: 450,
    },
    {
      identity: 'pxw-tire-rotation-history',
      vehiclePlate: 'PXW 382',
      title: 'Tire Rotation',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.LOW,
      createdDaysAgo: 90,
      mechanicIndex: 3,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      serviceOffsetKm: 500,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 100,
      laborCost: 350,
    },
    {
      identity: 'tgd-engine-tune-up-history',
      vehiclePlate: 'TGD 908',
      title: 'Engine Tune-up',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 0,
      mechanicIndex: 0,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 20000,
      bufferDistanceKm: 1000,
      serviceOffsetKm: 3000,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 3200,
      laborCost: 1200,
    },
    {
      identity: 'nre-general-inspection-history',
      vehiclePlate: 'NRE 471',
      title: 'General Inspection',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 150,
      mechanicIndex: 4,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.SEMI_ANNUALLY,
      serviceOffsetKm: 2500,
      maintenanceClass: 'PREVENTIVE',
      partsCost: 900,
      laborCost: 650,
    },
    {
      identity: 'tgd-outsourced-brake-repair',
      vehiclePlate: 'TGD 908',
      title: 'Brake Inspection',
      status: MaintenanceStatus.COMPLETED,
      priority: MaintenancePriority.HIGH,
      createdDaysAgo: 60,
      mechanicIndex: 0,
      accountType: AccountType.OUTSOURCED,
      triggerType: MaintenanceTriggerType.MANUAL,
      serviceOffsetKm: 500,
      maintenanceClass: 'REPAIR',
      partsCost: 4500,
      laborCost: 1600,
    },
    {
      identity: 'ndg-tire-rotation-upcoming',
      vehiclePlate: 'NDG 5821',
      title: 'Tire Rotation',
      status: MaintenanceStatus.PENDING,
      priority: MaintenancePriority.LOW,
      createdDaysAgo: 2,
      mechanicIndex: 2,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 8000,
      bufferDistanceKm: 500,
      dueOffsetKm: 2500,
    },
    {
      identity: 'cak-brake-inspection-in-progress',
      vehiclePlate: 'CAK 9043',
      title: 'Brake Inspection',
      status: MaintenanceStatus.IN_PROGRESS,
      priority: MaintenancePriority.HIGH,
      createdDaysAgo: 5,
      mechanicIndex: 1,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.MONTHLY,
      timeDueInDays: 10,
      progressState: 'IN_PROGRESS',
    },
    {
      identity: 'wob-brake-inspection-odometer-overdue',
      vehiclePlate: 'WOB 2947',
      title: 'Brake Inspection',
      status: MaintenanceStatus.OVERDUE,
      priority: MaintenancePriority.HIGH,
      createdDaysAgo: 20,
      mechanicIndex: 2,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 5000,
      bufferDistanceKm: 500,
      dueOffsetKm: -750,
      progressState: 'IN_PROGRESS',
      overdueFromStatus: MaintenanceStatus.IN_PROGRESS,
    },
    {
      identity: 'pxw-oil-change-due',
      vehiclePlate: 'PXW 382',
      title: 'Oil Change',
      status: MaintenanceStatus.DUE,
      priority: MaintenancePriority.HIGH,
      createdDaysAgo: 5,
      mechanicIndex: 3,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 5000,
      bufferDistanceKm: 500,
      dueOffsetKm: 0,
    },
    {
      identity: 'tgd-general-inspection-submitted',
      vehiclePlate: 'TGD 908',
      title: 'General Inspection',
      status: MaintenanceStatus.DONE,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 5,
      mechanicIndex: 4,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      timeDueInDays: 14,
      maintenanceClass: 'PREVENTIVE',
      progressState: 'SUBMITTED',
      partsCost: 150,
      laborCost: 400,
    },
    {
      identity: 'tgd-oil-change-time-overdue',
      vehiclePlate: 'TGD 908',
      title: 'Oil Change',
      status: MaintenanceStatus.OVERDUE,
      priority: MaintenancePriority.HIGH,
      createdDaysAgo: 20,
      mechanicIndex: 1,
      accountType: AccountType.OUTSOURCED,
      triggerType: MaintenanceTriggerType.TIME,
      intervalType: MaintenanceIntervalType.QUARTERLY,
      timeDueInDays: -7,
      progressState: 'IN_PROGRESS',
      overdueFromStatus: MaintenanceStatus.IN_PROGRESS,
    },
    {
      identity: 'nre-brake-inspection-upcoming',
      vehiclePlate: 'NRE 471',
      title: 'Brake Inspection',
      status: MaintenanceStatus.PENDING,
      priority: MaintenancePriority.MEDIUM,
      createdDaysAgo: 1,
      mechanicIndex: 3,
      accountType: AccountType.OUTSOURCED,
      triggerType: MaintenanceTriggerType.ODOMETER,
      intervalKm: 18000,
      bufferDistanceKm: 800,
      dueOffsetKm: 4000,
    },
    {
      identity: 'pxw-general-inspection-cancelled',
      vehiclePlate: 'PXW 382',
      title: 'General Inspection',
      status: MaintenanceStatus.CANCELLED,
      priority: MaintenancePriority.LOW,
      createdDaysAgo: 30,
      mechanicIndex: 4,
      accountType: AccountType.IN_HOUSE,
      triggerType: MaintenanceTriggerType.MANUAL,
    },
  ];

  const dayMilliseconds = 24 * 60 * 60 * 1000;
  const fixtureDate = (daysFromAnchor: number) =>
    new Date(
      maintenanceFixtureAnchor.getTime() + daysFromAnchor * dayMilliseconds,
    );
  const subtractTimeInterval = (
    date: Date,
    interval: { value: number; unit: 'DAYS' | 'MONTHS' },
  ) => {
    const previous = new Date(date);
    if (interval.unit === 'DAYS') {
      previous.setUTCDate(previous.getUTCDate() - interval.value);
    } else {
      const day = previous.getUTCDate();
      previous.setUTCDate(1);
      previous.setUTCMonth(previous.getUTCMonth() - interval.value);
      const lastDay = new Date(
        Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth() + 1, 0),
      ).getUTCDate();
      previous.setUTCDate(Math.min(day, lastDay));
    }
    return previous;
  };

  const maintenanceSchedulesData = scheduleFixtures.map((fixture, index) => {
    const vehicle = vehicles.find(
      (entry) => entry.plateNumber === fixture.vehiclePlate,
    );
    if (!vehicle?.garageId) {
      throw new Error(
        `Cannot seed schedule "${fixture.identity}": active vehicle or garage assignment is missing.`,
      );
    }
    const mechanic = mechanics[fixture.mechanicIndex];
    const chiefMechanic = chiefMechanics[index % chiefMechanics.length];
    const checklistTemplate = templateByType.get(fixture.title);
    const checklistItems = checklistItemsByType.get(fixture.title);
    if (!checklistTemplate || !checklistItems?.length) {
      throw new Error(
        `Cannot seed schedule "${fixture.identity}": checklist template "${fixture.title}" or its active items are missing.`,
      );
    }
    if (
      (fixture.accountType === AccountType.IN_HOUSE && !mechanic) ||
      !chiefMechanic?.userId
    ) {
      throw new Error(
        `Cannot seed schedule "${fixture.identity}": assigned or chief mechanic identity is missing.`,
      );
    }

    const rawCreatedAt = fixtureDate(-fixture.createdDaysAgo);
    const createdAt = shiftMaintenanceFixtureDate(rawCreatedAt);
    const isCompleted = fixture.status === MaintenanceStatus.COMPLETED;
    let odometerReading = vehicle.odometer;
    let startingReferenceReadingKm: number | null = null;
    const serviceOffsetKm = fixture.serviceOffsetKm;
    if (
      isCompleted &&
      serviceOffsetKm != null &&
      (!Number.isSafeInteger(serviceOffsetKm) || serviceOffsetKm <= 0)
    ) {
      throw new Error(
        `Cannot seed completed schedule "${fixture.identity}": service offset must be positive.`,
      );
    }

    if (fixture.triggerType === MaintenanceTriggerType.ODOMETER) {
      const intervalKm = fixture.intervalKm;
      if (
        intervalKm == null ||
        !Number.isSafeInteger(intervalKm) ||
        intervalKm <= 0
      ) {
        throw new Error(
          `Cannot seed schedule "${fixture.identity}": odometer interval must be a positive whole number.`,
        );
      }
      if (isCompleted) {
        if (serviceOffsetKm == null) {
          throw new Error(
            `Cannot seed completed schedule "${fixture.identity}": service offset must be positive.`,
          );
        }
        odometerReading = reconcileSeedOdometerReading(
          Math.max(1, vehicle.odometer - serviceOffsetKm),
          vehicle.odometer,
        )!;
        startingReferenceReadingKm = odometerReading - intervalKm;
      } else {
        const dueOffsetKm = fixture.dueOffsetKm ?? 0;
        startingReferenceReadingKm =
          vehicle.odometer + dueOffsetKm - intervalKm;
      }
      if (
        startingReferenceReadingKm < 0 ||
        startingReferenceReadingKm > odometerReading ||
        odometerReading > vehicle.odometer
      ) {
        throw new Error(
          `Cannot seed schedule "${fixture.identity}": odometer values do not fit the current vehicle reading.`,
        );
      }
    } else if (isCompleted && serviceOffsetKm != null) {
      odometerReading = reconcileSeedOdometerReading(
        Math.max(1, vehicle.odometer - serviceOffsetKm),
        vehicle.odometer,
      )!;
    }

    let startReferenceDate: Date | null = null;
    if (fixture.triggerType === MaintenanceTriggerType.TIME) {
      const interval = getTimeInterval({ intervalType: fixture.intervalType });
      if (!interval) {
        throw new Error(
          `Cannot seed time-based schedule "${fixture.identity}": interval preset is missing.`,
        );
      }
      const targetDueFixtureDate = isCompleted
        ? rawCreatedAt
        : fixtureDate(fixture.timeDueInDays ?? 30);
      if (targetDueFixtureDate < rawCreatedAt) {
        throw new Error(
          `Cannot seed schedule "${fixture.identity}": target due date precedes its creation date.`,
        );
      }
      startReferenceDate = shiftMaintenanceFixtureDate(
        subtractTimeInterval(targetDueFixtureDate, interval),
      );
    }

    const progressState = fixture.progressState;
    const hasWorkProgress =
      isCompleted ||
      fixture.status === MaintenanceStatus.DONE ||
      progressState != null;
    const checklistComplete =
      isCompleted ||
      fixture.status === MaintenanceStatus.DONE ||
      progressState === 'SUBMITTED';
    const workOrderProgress = hasWorkProgress
      ? {
          checklist: checklistItems.map((item, itemIndex) => {
            const completed = checklistComplete || itemIndex < 2;
            return {
              item,
              completed,
              ...(completed
                ? {
                    notes: `Synthetic ${fixture.title.toLowerCase()} check recorded.`,
                    selectedOption: 'yes',
                  }
                : {}),
            };
          }),
          ...(fixture.overdueFromStatus
            ? { overdueFromStatus: fixture.overdueFromStatus }
            : {}),
          ...(fixture.status === MaintenanceStatus.DONE
            ? {
                maintenanceClass: fixture.maintenanceClass ?? 'PREVENTIVE',
                maintenanceRemarks: `Synthetic work submitted for ${fixture.title}.`,
                serviceOdometerReading: odometerReading,
                workCompletedAt: createdAt.toISOString(),
                laborCost: fixture.laborCost ?? 0,
              }
            : {}),
        }
      : undefined;

    if (isCompleted && !fixture.maintenanceClass) {
      throw new Error(
        `Completed schedule "${fixture.identity}" needs a maintenance classification.`,
      );
    }
    const assignedMechanic =
      fixture.accountType === AccountType.OUTSOURCED
        ? 'External workshop technician'
        : mechanic?.name;
    if (!assignedMechanic) {
      throw new Error(
        `Cannot seed schedule "${fixture.identity}": assigned mechanic identity is missing.`,
      );
    }
    const assignedMechanicId = resolveSeedMechanicId(
      assignedMechanic,
      fixture.accountType,
    );
    const partsCost = fixture.partsCost;
    const laborCost = fixture.laborCost;

    return {
      seedIdentity: fixture.identity,
      vehicleId: vehicle.plateNumber,
      title: fixture.title,
      status: fixture.status,
      priority: fixture.priority,
      createdAt,
      assignedMechanic,
      accountType: fixture.accountType,
      outsourcedProvider:
        fixture.accountType === AccountType.OUTSOURCED
          ? demoProviderName
          : null,
      checklistTemplateId: checklistTemplate.id,
      garageId: vehicle.garageId,
      odometerReading,
      triggerType: fixture.triggerType,
      intervalKm: fixture.intervalKm,
      bufferDistanceKm: fixture.bufferDistanceKm,
      startingReferenceReadingKm: startingReferenceReadingKm ?? undefined,
      intervalType: fixture.intervalType,
      startReferenceDate: startReferenceDate ?? undefined,
      startDate: createdAt,
      chiefMechanicId: chiefMechanic.userId,
      chiefMechanic: chiefMechanic.name,
      assignedMechanicId,
      ...(fixture.maintenanceClass
        ? { maintenanceClass: fixture.maintenanceClass }
        : {}),
      ...(workOrderProgress ? { workOrderProgress } : {}),
      ...(partsCost !== undefined ? { partsCost } : {}),
      ...(laborCost !== undefined ? { laborCost } : {}),
      ...(partsCost !== undefined || laborCost !== undefined
        ? { totalCost: (partsCost ?? 0) + (laborCost ?? 0) }
        : {}),
    };
  });

  const assertCompletedScheduleHasProgress = (schedule: any) => {
    if (
      schedule.status === MaintenanceStatus.COMPLETED &&
      schedule.workOrderProgress == null
    ) {
      throw new Error(
        `Completed maintenance schedule for vehicle ${schedule.vehicleId} must include workOrderProgress in seed data.`,
      );
    }
  };

  const pendingScheduleKey = (schedule: { vehicleId: string; title: string }) =>
    JSON.stringify(
      [schedule.vehicleId, schedule.title].map((value) =>
        value.replace(/^ +| +$/g, '').toLowerCase(),
      ),
    );
  const fixturePendingKeys = new Set<string>();
  for (const schedule of maintenanceSchedulesData) {
    if (schedule.status !== MaintenanceStatus.PENDING) continue;
    const key = pendingScheduleKey(schedule);
    if (fixturePendingKeys.has(key)) {
      throw new Error(
        `Cannot seed duplicate pending schedule for ${schedule.vehicleId}: ${schedule.title}.`,
      );
    }
    fixturePendingKeys.add(key);
  }

  const existingPending = await prisma.maintenanceSchedule.findMany({
    where: { status: MaintenanceStatus.PENDING, deletedAt: null },
    select: { id: true, vehicleId: true, title: true },
  });
  const pendingScheduleIdsByKey = new Map<string, Set<string>>();
  const registerPendingSchedule = (schedule: {
    id: string;
    vehicleId: string;
    title: string;
  }) => {
    const key = pendingScheduleKey(schedule);
    const ids = pendingScheduleIdsByKey.get(key) ?? new Set<string>();
    ids.add(schedule.id);
    pendingScheduleIdsByKey.set(key, ids);
  };
  const hasPendingScheduleConflict = (key: string, exceptId: string) =>
    [...(pendingScheduleIdsByKey.get(key) ?? [])].some((id) => id !== exceptId);
  existingPending.forEach(registerPendingSchedule);
  const existingPendingIds = new Set(existingPending.map(({ id }) => id));

  if (!existingDemoProvider) {
    await prisma.outsourcedProvider.create({
      data: {
        id: seedId('outsourced-provider:vmms-demo-workshop'),
        name: demoProviderName,
        isActive: true,
      },
    });
  }

  const createNextSeedMaintenanceSchedule = async (completedSchedule: any) => {
    const triggerType = completedSchedule.triggerType;
    const isOdometerRecurring = triggerType === MaintenanceTriggerType.ODOMETER;
    const isTimeRecurring = triggerType === MaintenanceTriggerType.TIME;

    if (!isOdometerRecurring && !isTimeRecurring) return null;
    if (
      isOdometerRecurring &&
      (!Number.isSafeInteger(completedSchedule.intervalKm) ||
        completedSchedule.intervalKm <= 0)
    ) {
      throw new Error(
        `Cannot seed recurring maintenance for ${completedSchedule.vehicleId}: odometer interval must be a positive whole number.`,
      );
    }

    const progress = (completedSchedule.workOrderProgress ?? {}) as Record<
      string,
      unknown
    >;
    const completionOdometer =
      progress.serviceOdometerReading ?? completedSchedule.odometerReading;
    const rawCompletionDate = progress.workCompletedAt;
    const completionDate =
      typeof rawCompletionDate === 'string' &&
      Number.isFinite(Date.parse(rawCompletionDate))
        ? new Date(rawCompletionDate)
        : (completedSchedule.completedAt ?? completedSchedule.createdAt);
    const referenceDate = manilaCalendarDate(completionDate);
    const timeInterval = getTimeInterval(completedSchedule) ?? {
      value: 3,
      unit: 'MONTHS' as const,
    };
    const recurrenceIntervalType = isTimeRecurring
      ? (Object.values(MaintenanceIntervalType).find((intervalType) => {
          const preset = getTimeInterval({ intervalType });
          return (
            preset?.value === timeInterval.value &&
            preset.unit === timeInterval.unit
          );
        }) ?? null)
      : completedSchedule.intervalType;
    const vehicle = vehicles.find(
      (entry) => entry.plateNumber === completedSchedule.vehicleId,
    );
    if (!vehicle?.garageId) {
      throw new Error(
        `Cannot seed recurring maintenance for ${completedSchedule.vehicleId}: active vehicle garage assignment is missing.`,
      );
    }
    if (
      isOdometerRecurring &&
      (typeof completionOdometer !== 'number' ||
        !Number.isSafeInteger(completionOdometer) ||
        completionOdometer <= 0 ||
        completionOdometer + completedSchedule.intervalKm > 2147483647)
    ) {
      throw new Error(
        `Cannot seed recurring maintenance for ${completedSchedule.vehicleId}: service odometer or next threshold is invalid.`,
      );
    }
    if (
      isOdometerRecurring &&
      vehicle.odometer < (completionOdometer as number)
    ) {
      throw new Error(
        `Cannot seed recurring maintenance for ${completedSchedule.vehicleId}: vehicle odometer is behind the completed service reading.`,
      );
    }

    const pendingKey = pendingScheduleKey(completedSchedule);
    const recurrenceId = seedId(`recurrence:${completedSchedule.id}`);
    const existingSuccessor = await prisma.maintenanceSchedule.findUnique({
      where: { previousScheduleId: completedSchedule.id },
      select: { id: true, vehicleId: true, title: true, status: true },
    });
    if (existingSuccessor && existingSuccessor.id !== recurrenceId) {
      console.log(
        `  Preserved existing maintenance recurrence for ${completedSchedule.vehicleId}: ${completedSchedule.title}; skipped seed recurrence fixture.`,
      );
      return existingSuccessor;
    }
    if (hasPendingScheduleConflict(pendingKey, recurrenceId)) {
      console.log(
        `  Preserved existing pending schedule for ${completedSchedule.vehicleId}: ${completedSchedule.title}; skipped recurrence fixture.`,
      );
      return null;
    }

    const nextScheduleData = {
      vehicleId: completedSchedule.vehicleId,
      startDate: referenceDate,
      targetDueDate: sampleTargetDueDate({
        ...completedSchedule,
        startReferenceDate: referenceDate,
        startDate: referenceDate,
        createdAt: referenceDate,
        timeIntervalValue: isTimeRecurring ? timeInterval.value : null,
        timeIntervalUnit: isTimeRecurring ? timeInterval.unit : null,
      }),
      title: completedSchedule.title,
      status: MaintenanceStatus.PENDING,
      approvalStatus: MaintenanceApprovalStatus.UNVERIFIED,
      assignedMechanic: completedSchedule.assignedMechanic,
      assignedMechanicId: completedSchedule.assignedMechanicId,
      chiefMechanicId: completedSchedule.chiefMechanicId,
      chiefMechanic: completedSchedule.chiefMechanic,
      accountType: completedSchedule.accountType,
      outsourcedProvider: completedSchedule.outsourcedProvider,
      checklistTemplateId: completedSchedule.checklistTemplateId,
      garageId: vehicle.garageId,
      priority: completedSchedule.priority,
      odometerReading: vehicle.odometer,
      triggerType: completedSchedule.triggerType,
      intervalKm: completedSchedule.intervalKm,
      bufferDistanceKm: completedSchedule.bufferDistanceKm,
      startingReferenceReadingKm: isOdometerRecurring
        ? completionOdometer
        : null,
      intervalType: recurrenceIntervalType,
      timeIntervalValue: isTimeRecurring ? timeInterval.value : null,
      timeIntervalUnit: isTimeRecurring ? timeInterval.unit : null,
      startReferenceDate: isTimeRecurring ? referenceDate : null,
      previousScheduleId: completedSchedule.id,
      workOrderProgress: Prisma.DbNull,
      partsCost: null,
      laborCost: null,
      totalCost: null,
      logNumber: null,
      deletedAt: null,
      completedAt: null,
      createdAt: referenceDate,
    };
    const nextSchedule = await prisma.maintenanceSchedule.upsert({
      where: { id: recurrenceId },
      update: nextScheduleData,
      create: { id: recurrenceId, ...nextScheduleData },
    });
    if (nextSchedule.status === MaintenanceStatus.PENDING) {
      registerPendingSchedule(nextSchedule);
      existingPendingIds.add(nextSchedule.id);
    }
    return nextSchedule;
  };

  let createdMaintenanceSchedulesCount = 0;
  for (const schedule of maintenanceSchedulesData) {
    assertCompletedScheduleHasProgress(schedule);
    const scheduleId = seedId(`schedule:${schedule.seedIdentity}`);
    const pendingKey = pendingScheduleKey(schedule);
    if (
      schedule.status === MaintenanceStatus.PENDING &&
      hasPendingScheduleConflict(pendingKey, scheduleId) &&
      !existingPendingIds.has(scheduleId)
    ) {
      console.log(
        `  Preserved existing pending schedule for ${schedule.vehicleId}: ${schedule.title}; skipped conflicting fixture.`,
      );
      continue;
    }

    const isMaintenanceLog = schedule.status === MaintenanceStatus.COMPLETED;
    const maintenanceClass = (
      schedule as typeof schedule & {
        maintenanceClass?: 'REPAIR' | 'PREVENTIVE';
      }
    ).maintenanceClass;
    if (isMaintenanceLog && !maintenanceClass) {
      throw new Error(
        `Completed sample schedule "${schedule.title}" requires an explicit Repair or Preventive classification.`,
      );
    }
    const scheduleData = { ...schedule } as Record<string, any>;
    delete scheduleData.maintenanceClass;
    delete scheduleData.seedIdentity;
    scheduleData.targetDueDate =
      scheduleData.targetDueDate ?? sampleTargetDueDate(scheduleData);
    const existingSchedule = await prisma.maintenanceSchedule.findUnique({
      where: { id: scheduleId },
      select: { logNumber: true },
    });
    const [generatedLog] =
      isMaintenanceLog && !existingSchedule?.logNumber
        ? await prisma.$queryRaw<Array<{ logNumber: string }>>`
        WITH next_log_number AS (
          SELECT NEXTVAL('maintenance_log_number_seq') AS value
        )
        SELECT 'MLG-' || TO_CHAR(${schedule.createdAt}::timestamptz AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') || '-' ||
          LPAD(next_log_number.value::TEXT, GREATEST(4, LENGTH(next_log_number.value::TEXT)), '0') AS "logNumber"
        FROM next_log_number
      `
        : [];
    const persistedSchedule = {
      ...scheduleData,
      logNumber: isMaintenanceLog
        ? (existingSchedule?.logNumber ?? generatedLog?.logNumber ?? null)
        : null,
      ...stateForStorage(
        {
          ...((schedule.workOrderProgress ?? {}) as Record<string, any>),
          ...(isMaintenanceLog
            ? {
                maintenanceClass,
                maintenanceRemarks:
                  (
                    schedule.workOrderProgress as
                      Record<string, unknown> | undefined
                  )?.maintenanceRemarks ??
                  `Sample maintenance record: ${schedule.title} service completed.`,
                serviceOdometerReading: schedule.odometerReading,
                workCompletedAt:
                  (
                    schedule.workOrderProgress as
                      Record<string, unknown> | undefined
                  )?.workCompletedAt ?? schedule.createdAt.toISOString(),
                laborCost: schedule.laborCost ?? 0,
              }
            : {}),
        },
        schedule.status,
      ),
    };
    const createData = (
      schedule.status === MaintenanceStatus.COMPLETED
        ? {
            ...persistedSchedule,
            approvalStatus: MaintenanceApprovalStatus.VERIFIED,
            completedAt: schedule.createdAt,
          }
        : persistedSchedule
    ) as any;
    const updateData = {
      ...persistedSchedule,
      approvalStatus: isMaintenanceLog
        ? MaintenanceApprovalStatus.VERIFIED
        : MaintenanceApprovalStatus.UNVERIFIED,
      completedAt: isMaintenanceLog ? schedule.createdAt : null,
      startingReferenceReadingKm: schedule.startingReferenceReadingKm ?? null,
      intervalType: schedule.intervalType ?? null,
      startReferenceDate: schedule.startReferenceDate ?? null,
      timeIntervalValue: null,
      timeIntervalUnit: null,
      previousScheduleId: null,
      workOrderProgress:
        schedule.workOrderProgress == null
          ? Prisma.DbNull
          : persistedSchedule.workOrderProgress,
      partsCost: schedule.partsCost ?? null,
      laborCost: schedule.laborCost ?? null,
      totalCost: schedule.totalCost ?? null,
      deletedAt: null,
    };
    const createdSchedule = await prisma.maintenanceSchedule.upsert({
      where: { id: scheduleId },
      update: updateData,
      create: { ...createData, id: scheduleId },
    });
    createdMaintenanceSchedulesCount += 1;
    if (createdSchedule.status === MaintenanceStatus.PENDING) {
      registerPendingSchedule(createdSchedule);
      existingPendingIds.add(createdSchedule.id);
    }

    if (createdSchedule.status === MaintenanceStatus.COMPLETED) {
      const nextSchedule =
        await createNextSeedMaintenanceSchedule(createdSchedule);
      if (nextSchedule) createdMaintenanceSchedulesCount += 1;
    }
  }

  console.log(
    `  Processed ${createdMaintenanceSchedulesCount} sample maintenance schedules without replacing existing rows.\n`,
  );
}
