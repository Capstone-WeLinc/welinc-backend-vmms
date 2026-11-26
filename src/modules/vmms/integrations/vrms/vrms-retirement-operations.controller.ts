import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SystemType, UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RoleSystem, Roles } from '../../../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../../auth/guards/roles.guard';
import { VrmsRetirementDecisionDto } from './vrms-retirement-decision.dto';
import { VrmsRetirementRequestsService } from './vrms-retirement-requests.service';

type OperationsRequest = {
  user: { sub: string; email: string };
};

@Controller('integrations/vrms/retirement-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
@RoleSystem(SystemType.VMMS)
export class VrmsRetirementOperationsController {
  constructor(
    private readonly retirementRequests: VrmsRetirementRequestsService,
  ) {}

  @Roles(UserRole.OPERATIONS)
  @Get('pending')
  pending(
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.retirementRequests.pending(cursor, limit);
  }

  @Roles(UserRole.OPERATIONS)
  @Post(':requestId/decision')
  decide(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() body: VrmsRetirementDecisionDto,
    @Req() request: OperationsRequest,
  ) {
    return this.retirementRequests.decide(requestId, body, request.user);
  }
}
