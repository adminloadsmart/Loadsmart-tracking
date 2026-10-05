# loadsmart-tracking

Vehicle and trip tracking service for Loadsmart. It handles phone GPS (socket.io, every 15 s), BlackRock BR05 and SIM tracking (both pulled at intervals the org admin configures), ULIP FASTag checkpoints, the source waterfall, city and district naming via PostGIS, and the live map.

The full design and phased plan are in [docs/ROADMAP.md](docs/ROADMAP.md). **Current status: Phase 0 (foundations).**

## Process roles

One codebase and one Docker image. The `ROLE` env var picks what a process runs: `all`, or a comma list.

| Role | What it does | Port |
|---|---|---|
| `api` | REST API under `/v1` | `PORT` (4100) |
| `realtime` | socket.io: `/driver` for phone ingest (Phase 2) and `/live` for map viewers (Phase 3), websocket-only | `REALTIME_PORT` (4101) |
| `poller` | Pulls from BlackRock, Intugine and ULIP (Phase 4+) | — |
| `processor` | Consumes the point stream and runs the processing pipeline (Phase 1–2) | — |
| `scheduler` | Single leader through a Redis lock; runs the dispatcher, retention and outbox jobs | — |

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

| Script | |
|---|---|
| `npm run build` / `npm start` | Compile with the TS7 native compiler / run `dist` |
| `npm run lint` / `npm test` | ESLint, same rules as the main backend / vitest. The Redis tests skip if Redis isn't up |
| `npm run migration:create -- src/db/migrations/Name` | New empty migration. Use raw SQL for Timescale/PostGIS DDL |
| `npm run migration:run` / `migration:revert` | Apply or revert migrations (ts-node) |
| `npm run migration:run:prod` | Apply migrations from compiled `dist` (deploys and CI) |
| `npm run infra:up` / `infra:down` | Start or stop the local Postgres and Redis |

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
