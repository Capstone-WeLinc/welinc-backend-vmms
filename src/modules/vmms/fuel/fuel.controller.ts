import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { SystemType, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { RoleSystem, Roles } from '../../../auth/decorators/roles.decorator';
import { FuelActor, FuelService } from './fuel.service';
import {
  MAX_FUEL_ANOMALY_ATTACHMENT_BYTES,
  MAX_FUEL_RECEIPT_ATTEMPTS_PER_ACTOR_PER_MINUTE,
  MAX_FUEL_RECEIPT_BYTES,
} from './fuel.constants';
import { FuelReceiptScannerService } from './fuel-receipt-scanner.service';
import { VrmsRepairReferralsService } from '../integrations/vrms/vrms-repair-referrals.service';
import type { FuelReceiptFile } from './fuel-receipt-file';
import {
  FuelAcknowledgmentDto,
  FuelAnomalyNoteDto,
  FuelExportDto,
  FuelFillUpDto,
  FuelStationDto,
  UpdateFuelStationDto,
  UpdateFuelAnomalyThresholdDto,
  VoidFuelDto,
} from './fuel.dto';
import {
  FuelImportDraftDto,
  SaveFuelImportDto,
} from './dto/fuel-import.dto';

function fuelImportUploadInterceptor() {
  return FileInterceptor('file', {
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, callback) => {
      if (!file.originalname.toLowerCase().endsWith('.xlsx')) {
        callback(
          new BadRequestException('Upload an .xlsx fuel statement workbook.'),
          false,
        );
        return;
      }
      callback(null, true);
    },
  });
}

function fuelReceiptUploadInterceptor() {
  return FileInterceptor('file', {
    limits: { fileSize: MAX_FUEL_RECEIPT_BYTES + 1 },
    fileFilter: (_req, file, callback) => {
      const extension = file.originalname
        .toLowerCase()
        .slice(file.originalname.lastIndexOf('.'));
      const expectedMime =
        extension === '.jpg' || extension === '.jpeg'
          ? 'image/jpeg'
          : extension === '.png'
            ? 'image/png'
            : null;
      if (!expectedMime || file.mimetype.toLowerCase() !== expectedMime) {
        callback(
          new BadRequestException('Receipt must be a JPG, JPEG, or PNG image.'),
          false,
        );
        return;
      }
      callback(null, true);
    },
  });
}

@Controller('fuel')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class FuelController {
  private readonly receiptUploadTimes = new Map<string, number[]>();

  constructor(
    private readonly fuel: FuelService,
    private readonly receiptScanner: FuelReceiptScannerService,
    private readonly repairReferrals: VrmsRepairReferralsService,
  ) {}

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('stations')
  stations() {
    return this.fuel.listStations();
  }
  @Roles(UserRole.OPERATIONS)
  @Get('stations/management')
  stationsForManagement() {
    return this.fuel.listStationsForManagement();
  }
  @Roles(UserRole.OPERATIONS)
  @Post('stations')
  createStation(@Body() body: FuelStationDto) {
    return this.fuel.createStation(body.name);
  }
  @Roles(UserRole.OPERATIONS)
  @Patch('stations/:id')
  setStation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateFuelStationDto,
  ) {
    return this.fuel.updateStation(id, body);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('anomaly-threshold')
  getAnomalyThreshold(@Req() req: { user: FuelActor }) {
    return this.fuel.getAnomalyThreshold(req.user);
  }
  @Roles(UserRole.ADMIN)
  @Patch('anomaly-threshold')
  updateAnomalyThreshold(
    @Body() body: UpdateFuelAnomalyThresholdDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.updateAnomalyThreshold(body.thresholdPercent, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get()
  list(
    @Req() req: { user: FuelActor },
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.fuel.list(req.user, from, to);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('receipt/scan')
  @UseInterceptors(fuelReceiptUploadInterceptor())
  scanReceipt(
    @UploadedFile() file: FuelReceiptFile | undefined,
    @Req() req: { user: FuelActor },
  ) {
    return this.receiptScanner.scan(file, req.user.sub);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('import/preview')
  @UseInterceptors(fuelImportUploadInterceptor())
  previewImport(
    @UploadedFile() file: { buffer: Buffer } | undefined,
  ) {
    if (!file)
      throw new BadRequestException('Upload an .xlsx fuel statement workbook.');
    return this.fuel.previewImport(file.buffer);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('import')
  saveImport(
    @Body() dto: SaveFuelImportDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.saveImportRows(dto.rows, req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Get('import/drafts')
  listImportDrafts(@Req() req: { user: FuelActor }) {
    return this.fuel.listImportDrafts(req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Get('import/drafts/:id')
  getImportDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.getImportDraft(id, req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('import/drafts')
  createImportDraft(
    @Body() dto: FuelImportDraftDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.createImportDraft(dto.sourceName, dto.rows, req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch('import/drafts/:id')
  updateImportDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FuelImportDraftDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.updateImportDraft(
      id,
      dto.sourceName,
      dto.rows,
      req.user,
    );
  }

  @Roles(UserRole.OPERATIONS)
  @Delete('import/drafts/:id')
  deleteImportDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.deleteImportDraft(id, req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('with-receipt')
  @UseInterceptors(fuelReceiptUploadInterceptor())
  createWithReceipt(
    @Body() dto: FuelFillUpDto,
    @UploadedFile() file: FuelReceiptFile | undefined,
    @Req() req: { user: FuelActor },
  ) {
    if (!file)
      throw new BadRequestException(
        'Select a receipt image to save with this fuel entry.',
      );
    this.reserveReceiptUpload(req.user.sub);
    return this.fuel.create(dto, req.user, file);
  }

  private reserveReceiptUpload(actorId: string) {
    const now = Date.now();
    for (const [id, timestamps] of this.receiptUploadTimes) {
      const recent = timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (recent.length) this.receiptUploadTimes.set(id, recent);
      else this.receiptUploadTimes.delete(id);
    }

    const actorUploads = this.receiptUploadTimes.get(actorId) ?? [];
    if (actorUploads.length >= MAX_FUEL_RECEIPT_ATTEMPTS_PER_ACTOR_PER_MINUTE)
      throw new HttpException(
        'Too many receipt uploads. Try again in a minute.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    actorUploads.push(now);
    this.receiptUploadTimes.set(actorId, actorUploads);
  }

  @Roles(UserRole.OPERATIONS)
  @Get(':id/receipt')
  async getReceipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: FuelActor },
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.fuel.getReceiptAttachment(id, req.user);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.stream);
  }

  @Roles(UserRole.OPERATIONS)
  @Post()
  create(@Body() dto: FuelFillUpDto, @Req() req: { user: FuelActor }) {
    return this.fuel.create(dto, req.user);
  }
  @Roles(UserRole.OPERATIONS)
  @Post(':id/void')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VoidFuelDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.void(id, body.reason, req.user);
  }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Get('anomalies')
  anomalies(@Req() req: { user: FuelActor }) {
    return this.fuel.anomalies(req.user);
  }
  @Roles(UserRole.OPERATIONS)
  @Patch('anomalies/:id')
  updateAnomaly(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FuelAnomalyNoteDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.updateAnomaly(id, body, req.user);
  }
  @Roles(UserRole.OPERATIONS)
  @Post('anomalies/:id/attachments')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_FUEL_ANOMALY_ATTACHMENT_BYTES + 1 },
      fileFilter: (_req, file, callback) => {
        const ext = file.originalname
          .toLowerCase()
          .slice(file.originalname.lastIndexOf('.'));
        callback(null, ['.pdf', '.jpg', '.jpeg', '.png'].includes(ext));
      },
    }),
  )
  uploadAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile()
    file:
      { originalname: string; mimetype: string; buffer: Buffer } | undefined,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.uploadAnomalyAttachment(id, file, req.user);
  }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS, UserRole.CHIEF_MECHANIC)
  @Get('anomalies/:id/attachments/:attachmentId')
  async getAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() req: { user: FuelActor },
    @Res({ passthrough: true }) response: Response,
  ) {
    const file = await this.fuel.getAnomalyAttachment(
      id,
      attachmentId,
      req.user,
    );
    response.setHeader('Content-Type', file.contentType);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.name.replace(/["\\\r\n]/g, '_')}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(file.stream);
  }
  @Roles(UserRole.ADMIN, UserRole.CHIEF_MECHANIC)
  @Post('anomalies/:id/acknowledge')
  acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FuelAcknowledgmentDto,
    @Req() req: { user: FuelActor },
  ) {
    return this.fuel.acknowledgeAnomaly(id, body.remark, req.user);
  }

  @Roles(UserRole.ADMIN, UserRole.CHIEF_MECHANIC)
  @Post('anomalies/:id/repair-referrals')
  referAnomalyForRepair(@Param('id', ParseUUIDPipe) id: string) {
    return this.repairReferrals.createFromFuelAnomaly(id);
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get('report')
  report(
    @Req() req: { user: FuelActor },
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.fuel.report(from, to, req.user);
  }
  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Post('report/export')
  recordExport(@Body() body: FuelExportDto, @Req() req: { user: FuelActor }) {
    return this.fuel.recordReportExport(
      body.format,
      body.from,
      body.to,
      req.user,
    );
  }
}
