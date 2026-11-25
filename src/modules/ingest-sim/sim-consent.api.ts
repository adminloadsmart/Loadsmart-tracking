import { RequestHandler, Request, Response, Router } from 'express';
import { z } from 'zod';
import { hasPermission, type TenantScope, type StaffIdentity } from '../../shared/auth/staff-token';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from '../../shared/errors';
import { validate } from '../../shared/middleware/validate.middleware';
import { respond } from '../../shared/responses/respond';
import type { MainDataRepository } from '../main-data';
import { INDEXED_STATUSES } from '../trips/trip-state';
import type { SimConsentService, SimConsentSummary } from './sim-consent.service';
import type { SimTripStore } from './sim-trip.repository';

/** Who may send the consent link again: the same staff who work the live trips. */
export const SIM_CONSENT_RESEND_PERMISSION = 'trip.track';

class UnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503, 'UNAVAILABLE');
  }
}

export const simConsentParamsSchema = z.object({ params: z.object({ tripId: z.uuid() }) });

export type TripSimConsent =
  | { tripId: string; applicable: false; trackingSource: string | null }
  | ({ tripId: string; applicable: true } & SimConsentSummary);

/**
 * The console's view of a load's SIM consent (Valid with its date / Link sent and waiting /
 * Given), and the resend of the consent SMS, which is only possible while no valid consent is
 * available. Consent itself is per driver number and decided by SimConsentService.
 */
export class SimConsentApiService {
  constructor(
    /** `trip`: a load, else a trip created from the tracking screen. */
    private readonly mainData: Pick<MainDataRepository, 'trip'>,
    private readonly trips: Pick<SimTripStore, 'findLatestByTrip'>,
    private readonly consent: SimConsentService,
    /** False when the Intugine credentials are not set on this process: viewing works, resending not. */
    private readonly canSend: boolean,
  ) {}

  async get(scope: TenantScope, tripId: string): Promise<TripSimConsent> {
    const load = await this.mainData.trip(scope, tripId);
    if (!load) throw new NotFoundError(`Trip ${tripId} not found`);
    if (load.trackingSource !== 'sim') {
      return { tripId, applicable: false, trackingSource: load.trackingSource };
    }
    const summary = await this.consent.summarize(
      load.driverNumber,
      await this.trips.findLatestByTrip(tripId),
    );
    return { tripId, applicable: true, ...summary };
  }

  async resend(scope: TenantScope, user: StaffIdentity, tripId: string): Promise<TripSimConsent> {
    if (!hasPermission(user, SIM_CONSENT_RESEND_PERMISSION)) {
      throw new AuthorizationError(`Requires permission ${SIM_CONSENT_RESEND_PERMISSION}`);
    }
    const load = await this.mainData.trip(scope, tripId);
    if (!load) throw new NotFoundError(`Trip ${tripId} not found`);
    if (load.trackingSource !== 'sim') throw new ConflictError('This trip is not tracked by SIM');
    if (!INDEXED_STATUSES.includes(load.status) || !load.vehicleId) {
      throw new ConflictError('The consent link can only be sent while the trip is being tracked');
    }
    if (!this.canSend) {
      throw new UnavailableError('SIM tracking is not configured on this service');
    }
    await this.consent.resend({
      tenantId: load.tenantId,
      tripId,
      vehicleId: load.vehicleId,
      driverId: load.driverId,
      driverNumber: load.driverNumber,
    });
    return this.get(scope, tripId);
  }
}

function authOf(req: Request) {
  if (!req.tenantScope || !req.user) throw new AuthenticationError('Not authenticated');
  return { scope: req.tenantScope, user: req.user };
}

/** Mounted at /v1 behind staff auth (see app.ts). */
export function createSimConsentRoutes(service: SimConsentApiService): Router {
  const router = Router();
  const get: RequestHandler = async (req: Request, res: Response) => {
    respond(res, await service.get(authOf(req).scope, String(req.params.tripId)));
  };
  const resend: RequestHandler = async (req: Request, res: Response) => {
    const { scope, user } = authOf(req);
    respond(res, await service.resend(scope, user, String(req.params.tripId)));
  };
  router.get('/trips/:tripId/sim-consent', validate(simConsentParamsSchema), get);
  router.post('/trips/:tripId/sim-consent/resend', validate(simConsentParamsSchema), resend);
  return router;
}
