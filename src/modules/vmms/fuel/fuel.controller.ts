import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards, ParseUUIDPipe, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { FuelActor, FuelService } from './fuel.service';
import { MAX_FUEL_ANOMALY_ATTACHMENT_BYTES } from './fuel.constants';
import { FuelAcknowledgmentDto, FuelAnomalyNoteDto, FuelExportDto, FuelFillUpDto, FuelStationDto, UpdateFuelAnomalyThresholdDto, VoidFuelDto } from './fuel.dto';

@Controller('fuel')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class FuelController {
  constructor(private readonly fuel: FuelService) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('stations') stations() { return this.fuel.listStations(); }
  @Roles(UserRole.OPERATIONS)
  @Post('stations') createStation(@Body() body: FuelStationDto) { return this.fuel.createStation(body.name); }
  @Roles(UserRole.OPERATIONS)
  @Patch('stations/:id') setStation(@Param('id', ParseUUIDPipe) id: string, @Body() body: { isActive: boolean }) { return this.fuel.setStationActive(id, body.isActive); }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('anomaly-threshold') getAnomalyThreshold(@Req() req: { user: FuelActor }) { return this.fuel.getAnomalyThreshold(req.user); }
  @Roles(UserRole.ADMIN)
  @Patch('anomaly-threshold') updateAnomalyThreshold(@Body() body: UpdateFuelAnomalyThresholdDto, @Req() req: { user: FuelActor }) { return this.fuel.updateAnomalyThreshold(body.thresholdPercent, req.user); }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get()
  list(@Req() req: { user: FuelActor }, @Query('from') from?: string, @Query('to') to?: string) { return this.fuel.list(req.user, from, to); }
  @Roles(UserRole.OPERATIONS)
  @Post()
  create(@Body() dto: FuelFillUpDto, @Req() req: { user: FuelActor }) { return this.fuel.create(dto, req.user); }
  @Roles(UserRole.OPERATIONS)
  @Post(':id/void')
  void(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoidFuelDto, @Req() req: { user: FuelActor }) { return this.fuel.void(id, body.reason, req.user); }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Get('anomalies') anomalies(@Req() req: { user: FuelActor }) { return this.fuel.anomalies(req.user); }
  @Roles(UserRole.OPERATIONS)
  @Patch('anomalies/:id')
  updateAnomaly(@Param('id', ParseUUIDPipe) id: string, @Body() body: FuelAnomalyNoteDto, @Req() req: { user: FuelActor }) { return this.fuel.updateAnomaly(id, body, req.user); }
  @Roles(UserRole.OPERATIONS)
  @Post('anomalies/:id/attachments')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FUEL_ANOMALY_ATTACHMENT_BYTES + 1 }, fileFilter: (_req, file, callback) => { const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.')); callback(null, ['.pdf', '.jpg', '.jpeg', '.png'].includes(ext)); } }))
  uploadAttachment(@Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: { originalname: string; mimetype: string; buffer: Buffer } | undefined, @Req() req: { user: FuelActor }) { return this.fuel.uploadAnomalyAttachment(id, file, req.user); }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Get('anomalies/:id/attachments/:attachmentId')
  async getAttachment(@Param('id', ParseUUIDPipe) id: string, @Param('attachmentId', ParseUUIDPipe) attachmentId: string, @Req() req: { user: FuelActor }, @Res({ passthrough: true }) response: Response) {
    const file = await this.fuel.getAnomalyAttachment(id, attachmentId, req.user);
    response.setHeader('Content-Type', file.contentType); response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('Content-Disposition', `inline; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`); response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.stream);
  }
  @Roles(UserRole.ADMIN, UserRole.CHIEF_MECHANIC)
  @Post('anomalies/:id/acknowledge')
  acknowledge(@Param('id', ParseUUIDPipe) id: string, @Body() body: FuelAcknowledgmentDto, @Req() req: { user: FuelActor }) { return this.fuel.acknowledgeAnomaly(id, body.remark, req.user); }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('report')
  report(@Req() req: { user: FuelActor }, @Query('from') from?: string, @Query('to') to?: string) { return this.fuel.report(from, to, req.user); }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Post('report/export')
  recordExport(@Body() body: FuelExportDto, @Req() req: { user: FuelActor }) { return this.fuel.recordReportExport(body.format, body.from, body.to, req.user); }
}
