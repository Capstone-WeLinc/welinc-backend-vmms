import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import {
  MaintenanceCostingService,
  type MaintenanceCostingActor,
} from './maintenance-costing.service';
import {
  AuditMaintenanceCostingPdfExportDto,
  UpdateMaintenanceCostingThresholdDto,
} from './maintenance-costing.dto';

@Controller('maintenance-costing')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.ADMIN, UserRole.OPERATIONS)
export class MaintenanceCostingController {
  constructor(private readonly costingService: MaintenanceCostingService) {}

  @Get()
  getDashboard(@Query('from') from?: string, @Query('to') to?: string) {
    return this.costingService.getDashboard(from, to);
  }

  @Get('export.xlsx')
  async exportXlsx(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('selectedTruckId') selectedTruckId: string | undefined,
    @Req() req: { user: MaintenanceCostingActor },
    @Res() response: Response,
  ) {
    if (!from || !to) {
      throw new BadRequestException('Provide both from and to dates.');
    }
    const workbook = await this.costingService.exportXlsx(
      from,
      to,
      selectedTruckId,
      req.user,
    );
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="maintenance-costing-${from}-to-${to}.xlsx"`,
    );
    response.setHeader('Cache-Control', 'no-store');
    response.send(workbook);
  }

  @Post('export/pdf')
  auditPdfExport(
    @Body() body: AuditMaintenanceCostingPdfExportDto,
    @Req() req: { user: MaintenanceCostingActor },
  ) {
    return this.costingService.auditPdfExport(
      body.from,
      body.to,
      body.selectedTruckId,
      req.user,
    );
  }

  @Patch('threshold')
  @Roles(UserRole.ADMIN)
  updateThreshold(
    @Body() body: UpdateMaintenanceCostingThresholdDto,
    @Req() req: { user: MaintenanceCostingActor },
  ) {
    return this.costingService.updateThreshold(body.threshold, req.user);
  }
}
