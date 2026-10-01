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
  StreamableFile,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import type { ScheduleActor } from './schedule-access';
import { SystemType, UserRole } from '@prisma/client';
import { MaintenanceSchedulesService } from './maintenance-schedules.service';
import { CreateMaintenanceScheduleDto } from './dto/create-maintenance-schedule.dto';
import { CancelMaintenanceScheduleDto } from './dto/cancel-maintenance-schedule.dto';

type WorkOrderUploadFile = { originalname: string; mimetype: string; size: number; buffer: Buffer };

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

  @Roles(UserRole.MECHANIC)
  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.pdf', '.txt'];
      const extension = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));
      callback(null, allowed.includes(extension));
    },
  }))
  async uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('itemId') itemId: string,
    @UploadedFile() file: WorkOrderUploadFile,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.uploadAttachment(id, itemId, file, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC, UserRole.MECHANIC)
  @Get(':id/attachments/:attachmentId')
  async getAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: { user: ScheduleActor },
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.maintenanceSchedulesService.getAttachment(id, attachmentId, req.user);
    response.setHeader('Content-Type', attachment.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${attachment.name.replace(/[\"\\\r\n]/g, '_')}"`);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(attachment.stream);
  }

  @Roles(UserRole.MECHANIC)
  @Delete(':id/attachments/:attachmentId')
  async deleteAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.deleteAttachment(id, attachmentId, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.maintenanceSchedulesService.remove(id);
  }
}
