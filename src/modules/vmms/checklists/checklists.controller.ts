import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ChecklistsService } from './checklists.service';
import { CreateChecklistDto, UpdateChecklistDto } from './dto';

@Controller('checklists')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ChecklistsController {
  constructor(private readonly checklistsService: ChecklistsService) {}

  @Post()
  create(@Body() createChecklistDto: CreateChecklistDto) {
    return this.checklistsService.create(createChecklistDto);
  }

  @Get()
  findAll() {
    return this.checklistsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.checklistsService.findOne(id);
  }

  @Get('type/:type')
  findByType(@Param('type') type: string) {
    return this.checklistsService.findByType(type);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateChecklistDto: UpdateChecklistDto,
  ) {
    return this.checklistsService.update(id, updateChecklistDto);
  }

  @Patch('type/:type')
  updateByType(
    @Param('type') type: string,
    @Body() updateChecklistDto: UpdateChecklistDto,
  ) {
    return this.checklistsService.updateByType(type, updateChecklistDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.checklistsService.remove(id);
  }

  @Delete('type/:type')
  removeByType(@Param('type') type: string) {
    return this.checklistsService.removeByType(type);
  }

  @Post('sync')
  syncTemplates(
    @Body()
    templates: Record<string, { id: string; text: string }[]>,
  ) {
    return this.checklistsService.upsertMany(templates);
  }
}
