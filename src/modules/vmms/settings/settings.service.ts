import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma.service';
import { FuelService } from '../fuel/fuel.service';
import { MaintenanceCostingService } from '../maintenance-costing/maintenance-costing.service';

export type SettingsCatalogActor = {
  sub: string;
  email: string;
  roles: Array<{ system: string; role: string }>;
};

const fuelAnomalyKey = 'fuel_anomaly_threshold_percent';
const maintenanceCostKey = 'maintenance_cost_threshold';

@Injectable()
export class SettingsCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fuel: FuelService,
    private readonly costing: MaintenanceCostingService,
  ) {}

  private isAdmin(actor: SettingsCatalogActor) {
    return actor.roles.some(
      ({ system, role }) => system === 'VMMS' && role === 'ADMIN',
    );
  }

  private requireRead(actor: SettingsCatalogActor) {
    const allowed = actor.roles.some(
      ({ system, role }) =>
        system === 'VMMS' && ['ADMIN', 'OPERATIONS'].includes(role),
    );
    if (!allowed)
      throw new ForbiddenException('You do not have access to settings.');
  }

  private requireAdmin(actor: SettingsCatalogActor) {
    if (!this.isAdmin(actor))
      throw new ForbiddenException('Only an Admin can update settings.');
  }

  async getCatalog(actor: SettingsCatalogActor) {
    this.requireRead(actor);

    const [fuelSetting, costSetting] = await Promise.all([
      this.prisma.fuelAnomalySetting.findUnique({
        where: { id: 'default' },
        select: {
          thresholdPercent: true,
          updatedAt: true,
        },
      }),
      this.prisma.maintenanceCostingSetting.findUnique({
        where: { id: 'default' },
        select: {
          threshold: true,
          updatedAt: true,
        },
      }),
    ]);

    const editable = this.isAdmin(actor);
    const fuelValue =
      fuelSetting?.thresholdPercent == null
        ? 20
        : Number(fuelSetting.thresholdPercent);
    const costValue =
      costSetting?.threshold == null ? null : Number(costSetting.threshold);

    return [
      {
        key: fuelAnomalyKey,
        label: 'Fuel anomaly threshold',
        description:
          'Percentage deviation used to flag unusually high fuel consumption.',
        unit: 'percent',
        valueType: 'decimal',
        defaultValue: 20,
        currentValue: fuelValue,
        effectiveValue: fuelValue,
        updatedAt: fuelSetting?.updatedAt ?? null,
        constraints: {
          min: 1,
          max: 99,
          maxDecimalPlaces: 2,
        },
        editable,
      },
      {
        key: maintenanceCostKey,
        label: 'Maintenance cost threshold',
        description:
          'Total maintenance cost amount used to flag high-cost vehicles.',
        unit: 'PHP',
        valueType: 'decimal',
        defaultValue: null,
        currentValue: costValue,
        effectiveValue: costValue,
        updatedAt: costSetting?.updatedAt ?? null,
        constraints: {
          min: 0.01,
          max: 9999999999.99,
          maxDecimalPlaces: 2,
          nullableBeforeFirstSet: true,
        },
        editable,
      },
    ];
  }

  async updateCatalog(
    key: string,
    value: number,
    actor: SettingsCatalogActor,
  ) {
    this.requireAdmin(actor);

    if (!Number.isFinite(value)) {
      throw new BadRequestException('Setting value must be a finite number.');
    }
    if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) {
      throw new BadRequestException(
        'Setting value must have at most two decimal places.',
      );
    }

    if (key === fuelAnomalyKey) {
      if (value < 1 || value > 99) {
        throw new BadRequestException(
          'Fuel anomaly threshold must be 1 to 99 percent.',
        );
      }
      await this.fuel.updateAnomalyThreshold(value, actor);
      return this.getCatalog(actor);
    }

    if (key === maintenanceCostKey) {
      if (value <= 0 || value > 9999999999.99) {
        throw new BadRequestException(
          'Maintenance cost threshold must be greater than 0 and at most 9999999999.99.',
        );
      }
      await this.costing.updateThreshold(value, {
        sub: actor.sub,
        email: actor.email,
      });
      return this.getCatalog(actor);
    }

    throw new NotFoundException('Unknown settings catalog key.');
  }
}
