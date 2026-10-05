import { Request, Response } from 'express';
import type { StaffIdentity, TenantScope } from '../../shared/auth/staff-token';
import { AuthenticationError } from '../../shared/errors';
import { respond } from '../../shared/responses/respond';
import type { RuleId } from '../rules';
import { AlertsService } from './alerts.service';
import type {
  ListAlertsQuery,
  UpdateRuleSettingBody,
  VehicleEventsQuery,
} from './alerts.validators';

function caller(req: Request): { scope: TenantScope; user: StaffIdentity } {
  if (!req.tenantScope || !req.user) throw new AuthenticationError('Not authenticated');
  return { scope: req.tenantScope, user: req.user };
}

export class AlertsController {
  constructor(private readonly service: AlertsService) {}

  list = async (req: Request, res: Response) => {
    const query = req.validatedQuery as ListAlertsQuery;
    respond(res, await this.service.list(caller(req).scope, query));
  };

  acknowledge = async (req: Request, res: Response) => {
    const { scope, user } = caller(req);
    respond(res, await this.service.acknowledge(scope, user, String(req.params.alertId)));
  };

  close = async (req: Request, res: Response) => {
    const { scope, user } = caller(req);
    respond(
      res,
      await this.service.close(scope, user, String(req.params.alertId), req.body.reason),
    );
  };

  tripEvents = async (req: Request, res: Response) => {
    respond(res, await this.service.tripEvents(caller(req).scope, String(req.params.tripId)));
  };

  vehicleEvents = async (req: Request, res: Response) => {
    const { from, to } = req.validatedQuery as VehicleEventsQuery;
    respond(
      res,
      await this.service.vehicleEvents(caller(req).scope, String(req.params.vehicleId), from, to),
    );
  };

  settings = async (req: Request, res: Response) => {
    respond(res, await this.service.settings(caller(req).scope));
  };

  updateSetting = async (req: Request, res: Response) => {
    const { scope, user } = caller(req);
    const { enabled, params } = req.body as UpdateRuleSettingBody;
    respond(
      res,
      await this.service.updateSetting(scope, user, req.params.ruleId as RuleId, enabled, params),
    );
  };
}
