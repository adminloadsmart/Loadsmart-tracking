# loadsmart-tracking

Vehicle and trip tracking service for Loadsmart. It handles phone GPS (socket.io, every 15 s), BlackRock BR05 and SIM tracking (both pulled at intervals the org admin configures), ULIP FASTag checkpoints, the source waterfall, city and district naming via PostGIS, and the live map.

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
| `poller`    | Pulls from BlackRock, Intugine and ULIP (Phase 4+)                                                                                                                 | —                      |
| `processor` | Point stream partitions (leased, rebalanced across instances): clean → movement → motion → distance → Timescale                                                    | —                      |
| `scheduler` | Single leader through a Redis lock; runs the dispatcher, retention and outbox jobs, and the TripWatcher that polls main's `loads` table into the active-trip index | —                      |

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
