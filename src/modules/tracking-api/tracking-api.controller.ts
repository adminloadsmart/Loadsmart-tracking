import { Request, Response } from 'express';
import type { TenantScope } from '../../shared/auth/staff-token';
import { AuthenticationError } from '../../shared/errors';
import { respond } from '../../shared/responses/respond';
import { TrackingApiService } from './tracking-api.service';
import type { ListTripsQuery, TimelineQuery, TripTrackQuery } from './tracking-api.validators';

function scopeOf(req: Request): TenantScope {
  if (!req.tenantScope) throw new AuthenticationError('Not authenticated');
  return req.tenantScope;
}

export class TrackingApiController {
  constructor(private readonly service: TrackingApiService) {}

  fleetLive = async (req: Request, res: Response) => {
    respond(res, await this.service.fleetLive(scopeOf(req)));
  };

  vehicleLocation = async (req: Request, res: Response) => {
    respond(res, await this.service.vehicleLocation(scopeOf(req), String(req.params.vehicleId)));
  };

  vehicleTimeline = async (req: Request, res: Response) => {
    const { from, to, resolution } = req.validatedQuery as TimelineQuery;
    respond(
      res,
      await this.service.vehicleTimeline(
        scopeOf(req),
        String(req.params.vehicleId),
        from,
        to,
        resolution,
      ),
    );
  };

  listTrips = async (req: Request, res: Response) => {
    const { state, limit, q } = req.validatedQuery as ListTripsQuery;
    respond(res, await this.service.listTrips(scopeOf(req), state, limit, q));
  };

  tripsSummary = async (req: Request, res: Response) => {
    respond(res, await this.service.summary(scopeOf(req)));
  };

  tripRoute = async (req: Request, res: Response) => {
    respond(res, await this.service.tripRoute(scopeOf(req), String(req.params.tripId)));
  };

  trip = async (req: Request, res: Response) => {
    respond(res, await this.service.trip(scopeOf(req), String(req.params.tripId)));
  };

  tripTrack = async (req: Request, res: Response) => {
    const { resolution, format, source } = req.validatedQuery as TripTrackQuery;
    respond(
      res,
      await this.service.tripTrack(
        scopeOf(req),
        String(req.params.tripId),
        resolution,
        format,
        source ?? null,
      ),
    );
  };
}
