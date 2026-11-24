import {
  Controller,
  ForbiddenException,
  Post,
  Body,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ServiceToken } from '../../../../auth/verify/token-verifier';
import { ServiceRoute } from '../../../../auth/verify/guards';
import { VrmsRepairEventDto } from './vrms-repair-event.dto';
import { VrmsRepairEventsService } from './vrms-repair-events.service';

type ServiceRequest = Request & { service?: ServiceToken };

@Controller('integrations/vrms')
@ServiceRoute('fleet.repair-status.write')
export class VrmsRepairEventsController {
  constructor(
    private readonly vrmsRepairEventsService: VrmsRepairEventsService,
  ) {}

  @Post('repair-events')
  async receive(
    @Body() event: VrmsRepairEventDto,
    @Req() request: ServiceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.service?.clientId !== 'vrms') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the VRMS service may send repair events.',
      });
    }
    return this.vrmsRepairEventsService.apply(event);
  }
}
