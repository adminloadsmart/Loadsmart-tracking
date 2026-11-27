# loadsmart-tracking

Vehicle and trip tracking service for Loadsmart. It handles phone GPS (socket.io, every 15 s), Roadcast GPS devices and Intugine SIM tracking (both pulled), ULIP FASTag checkpoints, the source waterfall, city and district naming via PostGIS, and the live map.

The full design and phased plan are in [docs/ROADMAP.md](docs/ROADMAP.md). **Current status: Phase 3.**

- Phone GPS ingest: the `/driver` socket feeds the point stream, then the processor, then Timescale.
- Read API: live fleet, trips, tracks and timelines under `/v1`.
- Live map: the `/live` socket, fed by Redis pub/sub.
- Loads (trips), vehicles and places are read directly from the main backend's tables.

Contracts:

- [docs/contracts/driver-socket.md](docs/contracts/driver-socket.md): driver app → tracking.
- [docs/contracts/tracking-api.md](docs/contracts/tracking-api.md): web portal ↔ tracking (REST and `/live`).

## What lives here (and what doesn't)

This service holds **only tracking data**: GPS points, vehicle and rule state, alerts and their episodes, planned routes, geocodes and rule settings. Everything else belongs to the main loadsmart backend, and this service doesn't copy it:

- **Main data.** It shares the main database and reads `loads.loads` (one load is one trip), `loads.requisitions`, `masters.vehicles` (with `truck_types` and `vehicle_telemetry_meta`), `masters.loading_points` and `customers.customer_delivery_points` directly. All of that SQL lives in one module, `src/modules/main-data`, so a main schema change has one place to land.
  - A trip watcher on the scheduler polls `loads` for changes. It keeps the Redis active-trip index that ingest and the rules read on every point.
- **Auth.** The main backend issues and revokes tokens. Tracking only checks them: the shared `JWT_SECRET` signature, the token's purpose and tenant, the main backend's revocation key in Redis, and permissions from the token.
- **Notifications.** Tracking publishes alert events to `tracking.events`, and the main backend sends the push and SMS.

## Process roles

One codebase and one Docker image. The `ROLE` env var picks what a process runs: `all`, or a comma list.

| Role        | What it does                                                                                                                                                       | Port                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `api`       | REST read API under `/v1` (staff token from the main backend). Requires `JWT_SECRET`                                                                               | `PORT` (4100)          |
| `realtime`  | socket.io, websocket-only: `/driver` for phone GPS ingest, `/live` for map viewers. Requires `JWT_SECRET`                                                          | `REALTIME_PORT` (4101) |
| `poller`    | Pulls from Roadcast (Intugine and ULIP to follow)                                                                                                                  | —                      |
| `processor` | Point stream partitions (leased, rebalanced across instances): clean → movement → motion → distance → Timescale                                                    | —                      |
| `scheduler` | Single leader through a Redis lock; runs the dispatcher, retention and outbox jobs, and the TripWatcher that polls main's `loads` table into the active-trip index | —                      |

In production, run the roles as separate deployments, at least `processor` apart from `api`. Each process has one Postgres pool, and every role in it shares that pool. With `ROLE=all`, a burst of heavy API reads waits behind the processor's batch transactions, and the processor waits behind the reads. The database is shared with the main backend, so size the pools per deployment:

| Env                       | Default | Guidance                                                                                                                                                                                                              |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_POOL_MAX`             | 10      | Processor: about the partitions it owns (≤ 16) plus a few. API: by request concurrency. Scheduler and poller: 5 is plenty. Keep the sum over all pods under Postgres `max_connections` minus the main backend's share |
| `DB_CONNECT_TIMEOUT_MS`   | 0 (off) | e.g. 5000: a saturated pool fails fast instead of queueing forever                                                                                                                                                    |
| `DB_STATEMENT_TIMEOUT_MS` | 0 (off) | e.g. 30000 on API pods. The running service applies it, and the migration CLI never does                                                                                                                              |
| `POINT_STREAM_MAXLEN`     | 200000  | Per partition, about 400 B each (16 × 200k ≈ 1.3 GB of Redis). Alert on `tracking_stream_lag`; `tracking_stream_trimmed_total` > 0 means points were lost                                                             |

Lowering `POINT_STREAM_MAXLEN` trims the existing streams on their next write, so deploy that change only while `tracking_stream_lag` is about 0.

### Changing `POINT_PARTITIONS`

At most `POINT_PARTITIONS` processor instances can do work, one per partition. Raising the count (16 → 64) moves vehicles to other partitions. If points left in the old layout were processed next to newer ones on the new layout, a vehicle's points would run out of order. Processors record the count in Redis (`trk:points:partitions`) and refuse to start with a different count while any old partition still holds unprocessed points. The ingest roles log an error when their count differs from that record. To change it:

1. Stop ingest: scale `realtime` and `poller` to 0 (phones buffer offline and resend; Roadcast is polled again later).
2. Wait until `tracking_stream_lag` and `tracking_stream_pending` are 0 on every partition.
3. Deploy every role with the new `POINT_PARTITIONS`, processors first.
4. Start ingest again.

Every process also serves these on `OPS_PORT` (9100):

- `/healthz`: liveness.
- `/readyz`: Postgres, Redis and per-role checks; returns 503 with details when one fails.
- `/metrics`: Prometheus.

## Local development

Needs Node 24 and Docker.

```bash
cp .env.example .env
npm ci
npm run infra:up          # Timescale+PostGIS on :5433, Redis on :6380
npm run migration:run
npm run dev               # ROLE=all, hot reload
curl localhost:9100/readyz
```

The infra ports are offset from the main `loadsmart` backend's (5432/6379), so both can run side by side.

To run a single role, start it with `ROLE` set, for example: `ROLE=scheduler OPS_PORT=9101 npm run dev`.

## Scripts

| Script                                                                        |                                                                                         |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run build` / `npm start`                                                 | Compile with the TS7 native compiler / run `dist`                                       |
| `npm run lint` / `npm test`                                                   | ESLint, same rules as the main backend / vitest. The Redis tests skip if Redis isn't up |
| `npm run migration:create -- src/db/migrations/Name`                          | New empty migration. Use raw SQL for Timescale/PostGIS DDL                              |
| `npm run migration:run` / `migration:revert`                                  | Apply or revert migrations (ts-node)                                                    |
| `npm run migration:run:prod`                                                  | Apply migrations from compiled `dist` (deploys and CI)                                  |
| `npm run infra:up` / `infra:down`                                             | Start or stop the local Postgres and Redis                                              |
| `npx tsx scripts/simulate-phones.ts --phones 2000 --duration 600 --burst 0.2` | Load-test the `/driver` socket against a running service                                |

## Docker

```bash
docker build -f docker/Dockerfile -t loadsmart-tracking .
docker compose -f docker/docker-compose.yml --profile app up -d   # infra + service (ROLE=all)
```

Migrations are a separate step and never run on boot: `docker run --rm <image> npm run migration:run:prod`.

## Conventions

These mirror the main `loadsmart` backend:

- Express 5, TypeORM with migrations only (`synchronize: false`), zod validation.
- `AppError` subclasses, with the `{ data }` / `{ error }` response shapes.
- `createXModule(dataSource, deps)` factories wired by hand in `src/composition-root.ts`.

Additions specific to this service:

- pino for structured logs, prom-client for metrics, and OpenTelemetry (enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set).
- GPS points will travel on partitioned Redis Streams. BullMQ is only for unordered jobs.
