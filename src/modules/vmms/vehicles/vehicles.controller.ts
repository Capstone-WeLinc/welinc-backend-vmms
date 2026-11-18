import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles, RoleSystem } from '../../../auth/decorators/roles.decorator';
import { SystemType, UserRole } from '@prisma/client';
import {
  VehiclesService,
  type VehicleAuditActor,
  type VehicleImportRow,
} from './vehicles.service';
import { CreateVehicleDto } from './dto/create-vehicle.dto';
import { SaveOdometerImportDto } from './dto/save-odometer-import.dto';
import { UpdateOdometerDto } from './dto/update-odometer.dto';
import { UpdateVehicleDto } from './dto/update-vehicle.dto';
import { UpdateVehicleMaintenanceDefaultsDto } from './dto/update-vehicle-maintenance-defaults.dto';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
@Roles(UserRole.OPERATIONS)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Roles(
    UserRole.ADMIN,
    UserRole.OPERATIONS,
    UserRole.CHIEF_MECHANIC,
    UserRole.MECHANIC,
  )
  @Get()
  async list(@Query('activeOnly') activeOnly?: string) {
    return this.vehiclesService.findAll(activeOnly === 'true');
  }

  @Roles(UserRole.ADMIN, UserRole.OPERATIONS)
  @Get(':id/audit')
  async auditHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.findAuditHistory(id);
  }

  @Roles(UserRole.OPERATIONS)
  @Get(':id/maintenance-defaults')
  async maintenanceDefaults(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.getMaintenanceDefaults(id);
  }

  @Roles(UserRole.OPERATIONS)
  @Put(':id/maintenance-defaults')
  async updateMaintenanceDefaults(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleMaintenanceDefaultsDto,
  ) {
    return this.vehiclesService.updateMaintenanceDefaults(id, dto);
  }

  @Post()
  async create(@Body() dto: CreateVehicleDto) {
    return this.vehiclesService.create(dto);
  }

  @Post('import/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        callback(null, file.originalname.toLowerCase().endsWith('.xlsx'));
      },
    }),
  )
  async previewExcel(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    if (!file) throw new BadRequestException('Upload an .xlsx vehicle file.');
    return this.vehiclesService.previewExcel(file.buffer);
  }

  @Post('import')
  async saveImport(@Body() body: { rows?: VehicleImportRow[] }) {
    if (!Array.isArray(body?.rows))
      throw new BadRequestException('Vehicle rows are required.');
    return this.vehiclesService.saveImportRows(body.rows);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('odometer/import/preview')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, callback) => {
        callback(null, file.originalname.toLowerCase().endsWith('.xlsx'));
      },
    }),
  )
  async previewOdometerExcel(
    @UploadedFile() file: { originalname: string; buffer: Buffer } | undefined,
  ) {
    if (!file) throw new BadRequestException('Upload an .xlsx odometer file.');
    return this.vehiclesService.previewOdometerExcel(file.buffer);
  }

  @Roles(UserRole.OPERATIONS)
  @Post('odometer/import')
  async saveOdometerImport(
    @Body() dto: SaveOdometerImportDto,
    @Req() req: { user: VehicleAuditActor },
  ) {
    return this.vehiclesService.saveOdometerImportRows(dto.rows, req.user);
  }

  @Roles(UserRole.OPERATIONS)
  @Patch(':id/odometer')
  async updateOdometer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOdometerDto,
    @Req() req: { user: VehicleAuditActor },
  ) {
    return this.vehiclesService.updateOdometer(id, dto.odometer, req.user);
  }

  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateVehicleDto,
    @Req() req: { user: VehicleAuditActor },
  ) {
    return this.vehiclesService.update(id, dto, req.user);
  }

  @Delete(':id')
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.vehiclesService.delete(id);
  }
}
