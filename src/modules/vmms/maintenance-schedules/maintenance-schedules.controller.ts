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
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';

@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MaintenanceSchedulesController {
  constructor(
    private readonly maintenanceSchedulesService: MaintenanceSchedulesService,
  ) {}

  @Get()
  async list() {
    return this.maintenanceSchedulesService.findAll();
  }

  @Post()
  async create(@Body() body: CreateMaintenanceScheduleDto) {
    return this.maintenanceSchedulesService.create(body);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: CreateMaintenanceScheduleDto,
  ) {
    return this.maintenanceSchedulesService.update(id, body);
  }

  @Patch(':id/progress')
  async updateProgress(@Param('id') id: string, @Body() body: unknown) {
    return this.maintenanceSchedulesService.updateProgress(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.maintenanceSchedulesService.remove(id);
  }
}
