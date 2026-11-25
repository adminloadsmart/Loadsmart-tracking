export { IntugineClient, IntugineError, jwtExpiryMs } from './intugine.client';
export type {
  IntugineClientOptions,
  SimProvider,
  StartTripInput,
  StartTripResult,
} from './intugine.client';
export {
  hasPosition,
  locationRowSchema,
  locationTimeMs,
  normalizePhone,
  toNormalizedPoint,
  toSimConsent,
} from './intugine.contract';
export type { LocationRow, SimConsent, SimConsentStatus, SimOwner } from './intugine.contract';
export { SimConsentService } from './sim-consent.service';
export type {
  ConsentOutcome,
  SimConsentOptions,
  SimConsentSummary,
  SimLoad,
} from './sim-consent.service';
export { MemoryConsentStore, SimConsentRepository } from './sim-consent.repository';
export type { SimConsentStore } from './sim-consent.repository';
export { SimConsentApiService, createSimConsentRoutes } from './sim-consent.api';
export { addMonths, applyObservation, isConsentValid } from './sim-consent.record';
export type { ConsentRecord, SimConsentView } from './sim-consent.record';
export { SimTripRepository } from './sim-trip.repository';
export type {
  ConsentUpdate,
  NewSimTrip,
  SimTripRow,
  SimTripState,
  SimTripStore,
} from './sim-trip.repository';
export { SimLifecycleService } from './sim-lifecycle.service';
export type { LifecycleResult, SimLifecycleOptions, SimMainData } from './sim-lifecycle.service';
export { SIM_POLL_JOB, SIM_POLL_QUEUE, SimPollDispatcher } from './sim-poll.dispatcher';
export type { SimPollDispatcherOptions } from './sim-poll.dispatcher';
export { RedisSimCursors, SIM_CURSOR_KEY, SIM_LIMIT_STEP_KEY, SimPollJob } from './sim-poll.job';
export type { SimCursorStore, SimPollJobData, SimPollOptions, SimPollResult } from './sim-poll.job';

/** The consent thresholds from the env settings (one place, so every role reads them alike). */
export function simConsentOptionsFromEnv(config: {
  intugineConsentCheckMin: number;
  intugineConsentTtlMin: number;
  simConsentValidityMonths: number;
  simConsentResendGapMin: number;
}) {
  return {
    checkIntervalMs: config.intugineConsentCheckMin * 60_000,
    ttlMs: config.intugineConsentTtlMin * 60_000,
    validityMonths: config.simConsentValidityMonths,
    resendGapMs: config.simConsentResendGapMin * 60_000,
  };
}
