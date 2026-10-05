import { Request, Response } from 'express';
import { AuthenticationError } from '../../shared/errors';
import { respond } from '../../shared/responses/respond';
import { RouteApprovalService } from './route-approval.service';

export interface ApproveRouteBody {
  reason: string;
  polyline?: string;
  replan?: boolean;
  promisedDeliveryAt?: Date;
}

export class RoutesController {
  constructor(private readonly service: RouteApprovalService) {}

  approve = async (req: Request, res: Response) => {
    if (!req.tenantScope || !req.user) throw new AuthenticationError('Not authenticated');
    const body = req.body as ApproveRouteBody;
    respond(
      res,
      await this.service.approve(req.tenantScope, req.user, String(req.params.tripId), body),
      201,
    );
  };
}
