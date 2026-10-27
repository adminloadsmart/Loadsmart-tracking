import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Namespace } from 'socket.io';
import { DataSource } from 'typeorm';
import type { PointPublisher } from '../points';
import type { ActiveTripIndex } from '../trips';
import { createTokenBlocklist } from '../../shared/auth/token-blocklist';
import { createDriverSocketAuth } from './driver-socket-auth';
import { DriverSocketOptions, registerDriverNamespace } from './driver-socket.handler';
import { TripResolver } from './trip-resolver';
import { TripRepository } from './trip.repository';

export interface IngestPhoneDeps {
  dataSource: DataSource;
  /** The main loadsmart backend's Redis (token blocklist). */
  mainRedis: Redis;
  activeTrips: ActiveTripIndex;
  publisher: PointPublisher;
  jwtSecret: string;
  logger: Logger;
  options: DriverSocketOptions;
}

/** Wires the /driver socket.io namespace: handshake auth + loc / loc:batch ingest. */
export function createIngestPhoneModule(deps: IngestPhoneDeps) {
  const resolver = new TripResolver(deps.activeTrips, new TripRepository(deps.dataSource));
  const isBlocked = createTokenBlocklist(deps.mainRedis, deps.logger);
  // The driver's live active tenants (masters.driver_tenant_relations), for identity-scoped tokens.
  const activeTenantIds = async (driverId: string): Promise<string[]> => {
    const rows: Array<{ tenantId: string }> = await deps.dataSource
      .createQueryBuilder()
      .select('r.tenant_id', 'tenantId')
      .from('masters.driver_tenant_relations', 'r')
      .where('r.driver_id = :driverId', { driverId })
      .andWhere("r.status = 'active'")
      .andWhere('r.deleted_at IS NULL')
      .getRawMany();
    return rows.map((row) => row.tenantId);
  };

  return {
    attach(namespace: Namespace): void {
      namespace.use(createDriverSocketAuth({ jwtSecret: deps.jwtSecret, isBlocked, activeTenantIds }));
      registerDriverNamespace(namespace, {
        publisher: deps.publisher,
        resolver,
        logger: deps.logger,
        options: deps.options,
      });
    },
  };
}

export type { Ack } from './driver-socket.handler';
export { DRIVER_SOCKET_MAX_MESSAGE_BYTES } from './driver-socket.handler';
export type { DriverIdentity } from './driver-socket-auth';
