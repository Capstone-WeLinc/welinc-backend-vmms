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
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import type { ScheduleActor } from './schedule-access';
import { UserRole } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';

@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
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

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Post()
  async create(@Body() body: CreateMaintenanceScheduleDto) {
    return this.maintenanceSchedulesService.create(body);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: CreateMaintenanceScheduleDto,
  ) {
    return this.maintenanceSchedulesService.update(id, body);
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
