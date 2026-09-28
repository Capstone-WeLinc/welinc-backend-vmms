import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Put,
  Patch,
  Param,
  Delete,
  Query,
  Req,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import type { ScheduleActor } from './schedule-access';
import { SystemType, UserRole } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { CancelMaintenanceScheduleDto } from './dto/cancel-maintenance-schedule.dto';

@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class MaintenanceSchedulesController {
  constructor(
    private readonly maintenanceSchedulesService: MaintenanceSchedulesService,
  ) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get()
  async list(@Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.findAll(req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get('search')
  async search(@Query('q') q: string, @Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.findAll(req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Post()
  async create(@Body() body: CreateMaintenanceScheduleDto) {
    return this.maintenanceSchedulesService.create(body);
  }

  @Roles(UserRole.OPERATIONS)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: CreateMaintenanceScheduleDto,
  ) {
    return this.maintenanceSchedulesService.update(id, body);
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':id/cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() body: CancelMaintenanceScheduleDto, @Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.cancel(id, body.reason, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Patch(':id/progress')
  async updateProgress(@Param('id') id: string, @Body() body: unknown, @Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.updateProgress(id, body, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.maintenanceSchedulesService.remove(id);
  }
}
