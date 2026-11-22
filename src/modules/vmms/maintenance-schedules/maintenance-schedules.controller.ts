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
import { UpdateWorkOrderPriorityDto } from './dto/update-work-order-priority.dto';
import { UpdateMaintenanceLogDto } from './dto/update-maintenance-log.dto';
import { ReviewMaintenanceCancellationDto } from './dto/review-maintenance-cancellation.dto';
import { CreateMaintenanceScheduleExtensionDto } from './dto/create-maintenance-schedule-extension.dto';
import { ReviewMaintenanceScheduleExtensionDto } from './dto/review-maintenance-schedule-extension.dto';

type WorkOrderUploadFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@Controller('maintenance-schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class MaintenanceSchedulesController {
  constructor(
    private readonly maintenanceSchedulesService: MaintenanceSchedulesService,
  ) {}

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Get()
  async list(@Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.findAll(req.user);
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
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
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.update(id, body, req.user);
  }

  @Roles(UserRole.MECHANIC)
  @Post(':id/extensions')
  async requestExtension(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateMaintenanceScheduleExtensionDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.requestExtension(
      id,
      body,
      req.user,
    );
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Get(':id/extensions')
  async extensionHistory(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.getExtensionHistory(id, req.user);
  }

  @Roles(UserRole.ADMIN)
  @Get('extensions/pending')
  async pendingExtensions(
    @Query('cursor', new ParseUUIDPipe({ optional: true })) cursor: string | undefined,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.findPendingExtensionRequests(
      req.user,
      cursor,
    );
  }

  @Roles(UserRole.ADMIN)
  @Post(':id/extensions/:requestId/review')
  async reviewExtension(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: ReviewMaintenanceScheduleExtensionDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.reviewExtensionRequest(
      id,
      requestId,
      body.decision,
      body.reason,
      req.user,
    );
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Patch(':id/priority')
  async updatePriority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateWorkOrderPriorityDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.updatePriority(
      id,
      body.priority,
      req.user,
    );
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':id/cancel')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelMaintenanceScheduleDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.cancel(id, body.reason, req.user);
  }

  @Roles(UserRole.ADMIN)
  @Post(':id/cancellation-requests/:requestId/review')
  async reviewCancellationRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: ReviewMaintenanceCancellationDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.reviewCancellationRequest(
      id,
      requestId,
      body.decision,
      body.reason,
      req.user,
    );
  }

  @Roles(UserRole.ADMIN)
  @Post(':id/cancel-log')
  async cancelMaintenanceLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelMaintenanceScheduleDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.cancelMaintenanceLog(
      id,
      body.reason,
      req.user,
    );
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':id/unlock-log')
  async unlockMaintenanceLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelMaintenanceScheduleDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.unlockMaintenanceLog(
      id,
      body.reason,
      req.user,
    );
  }

  @Roles(UserRole.ADMIN)
  @Post(':id/unlock-requests/:requestId/review')
  async reviewMaintenanceLogUnlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: ReviewMaintenanceCancellationDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.reviewMaintenanceLogUnlock(
      id,
      requestId,
      body.decision,
      body.reason,
      req.user,
    );
  }

  @Roles(UserRole.OPERATIONS)
  @Patch(':id/log-edit')
  async updateMaintenanceLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateMaintenanceLogDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.updateMaintenanceLog(
      id,
      body,
      req.user,
    );
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':id/void-log')
  async voidMaintenanceLog(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelMaintenanceScheduleDto,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.voidMaintenanceLog(
      id,
      body.reason,
      req.user,
    );
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Patch(':id/progress')
  async updateProgress(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.updateProgress(id, body, req.user);
  }

  @Roles(UserRole.MECHANIC)
  @Post(':id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        const allowed = [
          '.jpg',
          '.jpeg',
          '.png',
          '.webp',
          '.gif',
          '.mp4',
          '.pdf',
          '.txt',
        ];
        const extension = file.originalname
          .toLowerCase()
          .slice(file.originalname.lastIndexOf('.'));
        callback(null, allowed.includes(extension));
      },
    }),
  )
  async uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('itemId') itemId: string,
    @UploadedFile() file: WorkOrderUploadFile,
    @Req() req: { user: ScheduleActor },
  ) {
    return this.maintenanceSchedulesService.uploadAttachment(
      id,
      itemId,
      file,
      req.user,
    );
  }

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Get(':id/attachments/:attachmentId')
  async getAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: { user: ScheduleActor },
    @Res({ passthrough: true }) response: Response,
  ) {
    const attachment = await this.maintenanceSchedulesService.getAttachment(
      id,
      attachmentId,
      req.user,
    );
    response.setHeader('Content-Type', attachment.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${attachment.name.replace(/["\\\r\n]/g, '_')}"`,
    );
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
    return this.maintenanceSchedulesService.deleteAttachment(
      id,
      attachmentId,
      req.user,
    );
  }

  @Roles(UserRole.ADMIN)
  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: { user: ScheduleActor }) {
    return this.maintenanceSchedulesService.remove(id, req.user);
  }
}
