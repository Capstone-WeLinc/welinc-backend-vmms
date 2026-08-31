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
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
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
  async list() {
    return this.maintenanceSchedulesService.findAll();
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get('search')
  async search(@Query('q') q: string) {
    return this.maintenanceSchedulesService.findAll();
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
  async updateProgress(@Param('id') id: string, @Body() body: unknown) {
    return this.maintenanceSchedulesService.updateProgress(id, body);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.maintenanceSchedulesService.remove(id);
  }
}
