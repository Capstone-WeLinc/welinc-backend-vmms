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
import { VrmsRepairEventsService } from './vrms-repair-events.service';
import { VrmsRepairReferralEventDto } from './vrms-repair-referral-event.dto';

type ServiceRequest = Request & { service?: ServiceToken };

@Controller('integrations/vrms')
@ServiceRoute('repair.referral-status.write')
export class VrmsRepairReferralEventsController {
  constructor(private readonly repairEvents: VrmsRepairEventsService) {}

  @Post('referral-events')
  async receive(
    @Body() event: VrmsRepairReferralEventDto,
    @Req() request: ServiceRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    if (request.service?.clientId !== 'vrms') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only the VRMS service may send referral outcomes.',
      });
    }
    return this.repairEvents.applyReferralOutcome(event);
  }
}
