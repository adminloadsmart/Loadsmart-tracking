# Loadsmart Tracking Microservice: Roadmap

## Context

The main `loadsmart` backend (Express 5, TypeORM, Postgres, BullMQ, ioredis) is a monolith.
- Tracking is done by hand today: a load moves through `at_plant`, `in_transit` and `reached_delivery_point` via `PATCH /loads/:id/status`.
- `src/modules/tracking/` is an empty scaffold.
- The only GPS-related fields are `vehicle_telemetry_meta.gpsProvider` and `gpsEnabled`.

This roadmap builds **`loadsmart-tracking`** (currently an empty directory) as a separate service. It owns:
- all location ingestion,
- trip and vehicle timelines,
- the source waterfall,
- PostGIS location naming,
- the live map.

It follows the two architecture docs, adjusted to the confirmed data sources below.

### Location sources (confirmed)

| # | Source | How we get it | Interval | Who controls it |
|---|---|---|---|---|
| 1 | **Driver phone GPS** | The app **pushes** over a persistent **socket.io** connection | **Fixed at 15 s** | Fixed in the app |
| 2 | **Roadcast GPS device** (replaced BlackRock BR05, 2026-10-23) | We **pull** from Roadcast's API: one call per org with its IMEIs | **10 s on trip**, 5 min idle | Fixed for all orgs (env) |
| 3 | **SIM tracking (Intugine)** | We **pull** from Intugine's API | **10–20 min** | **Org admin** |

- ULIP FASTag is pulled as a toll checkpoint only, not as a moving position.
- Integrated GPS via Intugine is dropped.
- There is **no TCP server**: device protocol work in the architecture doc is out of scope; Roadcast talks to the devices.
- **Waterfall priority is set per org by the org admin.** The default is Roadcast > Phone > SIM.
- Roadcast returns only the **latest** point per device. Whether the SIM API returns history is still **unknown**. The design handles both.

### Decisions taken
- **Stack:** the same as the main backend (Node 24, TypeScript, Express 5, TypeORM, zod, ioredis, BullMQ), plus socket.io.
- **Domain data:** tracking **shares the main database** and reads main's tables (loads, requisitions, vehicles, drivers, loading and delivery points) directly through one read-only adapter, `modules/main-data`. It never copies them: tracking tables hold only tracking data. (Changed from the original event-sync design in 4a7c563.)
- **Size:** sized for **up to about 2,000 vehicles**. Every component has a horizontal-scale path and a trigger metric.

### Load math at 2,000 active vehicles
- **Phone:** about 2,000 open sockets, one message every 15 seconds, so **about 133 messages per second**. That is about 11.5M rows per day if phones report around the clock.
- **Roadcast pull:** **one call per org every 10 s** while that org has a truck on a trip (one every 5 min otherwise), carrying the org's IMEIs. 50 active orgs is 5 calls/s, whatever the number of trucks. 2,000 trucks on trips give 200 points/s into the stream.
- **SIM pull at 10–20 min:** about **2–3 calls per second**. The load is trivial, but every call is billed.
- **Conclusion:** one Postgres with Timescale and one Redis are enough.
  - The real ceilings are the **provider rate limits and costs** and **storage growth**.
  - So batching of provider calls and retention are designed in from day one.

---

## 1. Service topology: one codebase, several process roles

One repo and one image. The `ROLE` environment variable picks what runs, which gives a modular monolith in which each role scales independently.

| Role | Does | Scales by | Day-1 count |
|---|---|---|---|
| `api` | REST (trips, vehicles, org settings, share links), OpenAPI | Stateless, autoscaled | 2 |
| `realtime` | socket.io: `/driver` namespace (phone **ingest**) and `/live` namespace (map **viewers**) | Horizontal, with the socket.io Redis adapter | 2 |
| `poller` | BullMQ workers that call the Roadcast, Intugine and ULIP APIs | Worker concurrency and instances, capped by provider rate limits | 1–2 |
| `processor` | Consumes the partitioned point stream and runs the processing pipeline | Number of partitions (16) | 2 |
| `scheduler` | Single leader (Redis lock) | Exactly one instance | 1 |

The scheduler runs:
- the due-poll dispatcher,
- the waterfall evaluator,
- retention and pruning,
- the outbox relay,
- the ULIP token refresh.

In local dev, `ROLE=all` runs every role in one process.

```
Driver phone ──socket.io /driver (15s)──► realtime ─┐
                                                     │
scheduler: dispatch     ─► BullMQ poll-roadcast ► poller ─► Roadcast API ─┤
                         └► BullMQ poll-sim  ─► poller ──► Intugine API  ─┼─► Redis Streams points:{0..15}
                         └► BullMQ poll-ulip ─► poller ──► ULIP API ──────┘     (partition = hash(vehicle_id))
                                                                                     │
                                         processor (1 owner per partition, in-order) ◄┘
              clean → motion-state → distance → location-resolve → geofence → ETA/delay/alerts
                 │                 │                        │
                 ▼                 ▼                        ▼
      Timescale location_points  Redis veh:{id}:latest   Postgres/PostGIS (context, events, trip_source_link)
                                   │
                         Redis pub/sub ─► realtime /live (rooms trip:/vehicle:/tenant:) ─► web + apps
                                   │
               outbox ─► Redis Stream tracking.events ─► main backend (auto milestones)
```

## 2. Repo layout (matches main backend conventions)

```
loadsmart-tracking/
  src/
    config/env.ts                       # required()/numberWithDefault() pattern
    db/{data-source.ts, migrations/, redis.ts}
    shared/  errors/ (AppError…), middleware/{auth,driver-auth,validate,request-id}, responses/respond.ts, logger.ts (pino)
    streams/ {stream-bus.ts, partitioner.ts, leased-consumer.ts, dlq.ts}
    polling/ {poll-registry.ts (ZSET due-queue), dispatcher.ts, provider-rate-limiter.ts, cursor-store.ts}
    adapters/ {roadcast.client.ts, intugine.client.ts, ulip.client.ts, s3-archive.adapter.ts, routes-eta.client.ts}
    modules/
      ingest-phone/      driver socket namespace, payload validators, offline-batch handler
      ingest-roadcast/   client, dispatcher, poll job, normalizer (binding = main's gps_device_imei)
      ingest-sim/        consent lifecycle, poll job, normalizer
      ingest-ulip/       poll job, token manager
      processing/        pipeline.ts + steps/{clean,motion-state,distance,geofence,eta,delay,overspeed,toll-match}.step.ts
      waterfall/         source-selector, no-signal detector, trip_source_link
      org-settings/      priority + intervals API, appliers (reschedule polls)
      location/          LocationResolver interface, PostGIS resolver, context service, boundary import
      main-data/         read-only adapter over main's tables (the only code that knows them)
      trips/             active-trip index + TripWatcher (polls loads.updated_at), lifecycle
      realtime/          /live namespace, rooms, throttled publisher
      share-links/       public trip link tokens, cached public endpoint
    entrypoints/{api,realtime,poller,processor,scheduler,all}.ts
    composition-root.ts                 # createXModule(dataSource, deps) wiring, as in main backend
  docker/{Dockerfile, docker-compose.yml}   # timescale+postgis, redis, minio
```

**Copy these patterns from the main backend** (separate repo, so copied, not imported):
- `src/config/env.ts`
- `src/shared/errors/*`
- `src/shared/middleware/validate.middleware.ts`
- `src/shared/responses/respond.ts`
- `src/shared/utils/token.ts` (verify only) and `token-blocklist.ts`
- `src/jobs/queue-registry.ts`
- the `src/adapters/*.client.ts` style for provider clients

**Rules for the two queue technologies:**
- **GPS points travel on raw Redis Streams, partitioned by vehicle**, which keeps each vehicle's points in order.
- **BullMQ is only for poll jobs and side jobs.** It has no per-key ordering, so points never go through it.

## 3. Ingestion design

### 3.1 Phone GPS over socket.io (push, every 15 s)
- **Namespace and auth:**
  - Namespace `/driver`. Transport is forced to `websocket`, with no HTTP long-polling, so the load balancer needs no sticky sessions for drivers.
  - The driver JWT (`purpose='driver-access'`) is verified in the handshake middleware.
  - The driver's `active` status is checked through a Redis cache with a 60 s TTL. There is no DB call per message.
  - On connect, the socket joins room `driver:{driverId}`, and the server records `drv:{id}:conn` (instance and connected time).
- **Events from the app:**
  - `loc` carries one point.
  - `loc:batch` carries up to 200 points: the offline queue, flushed on reconnect.
  - Both use **socket.io acks**. The server acks only after the XADD succeeds, and the app deletes points from its local queue only when acked. This gives at-least-once delivery with no data loss over flaky mobile networks.
- **Payload:** `pointId` (UUIDv7), `lat`, `lng`, `accuracy` (m), `speed`, `bearing`, `altitude`, `recordedAt`, `isMock`, `batteryPct`, `provider`, `appState`.
- **Handler path:** zod validation, resolve `vehicleId` and `tripId` from Redis (driver → active trip), XADD, ack. **No Postgres on the hot path.**
- **Guards:**
  - At most one `loc` per 5 s per socket; anything faster is dropped with a warning.
  - Batches are capped at 200 points.
  - Payloads are capped at 64 KB.
- **Connection health:**
  - socket.io ping/pong runs at a 25 s interval.
  - A disconnect alone does **not** mean no-signal. No-signal is decided only by the last **accepted** point (section 5).
  - Before declaring the phone silent, the server sends a silent FCM push to wake the app, by emitting an event that the main backend acts on (it owns FCM tokens and all notifications).
- **Notes for the app team:**
  - Android: use the fused location provider in a foreground service, and ask drivers to whitelist the app from battery optimization.
  - Buffer locations in SQLite when offline.
  - Send every 15 s while moving. Optionally drop to 60 s while halted, if product allows.

### 3.2 Pull engine (shared by Roadcast, SIM and ULIP)
One generic engine. Each source plugs in an adapter with `fetch(targets, cursor) → NormalizedPoint[]`.
- **Due queue:**
  - A Redis ZSET `poll:due`: member is `{source}:{targetId}`, score is `next_due_at`.
  - The leader `dispatcher` runs every second. It atomically claims due members with a Lua script (`ZRANGEBYSCORE`, then `ZADD` with a lease time) and enqueues BullMQ jobs into `poll-{source}`.
  - Thousands of targets cost a single cheap loop, not thousands of repeatable jobs.
- **Workers:**
  - Concurrency is set per source.
  - A **BullMQ rate limiter per provider** matches each provider's quota.
  - Every provider call goes through an `opossum` circuit breaker.
  - Retries use backoff. After repeated failure, the target is marked `stale` and keeps its last-known position.
- **Batching:** if a provider has a multi-vehicle or bulk endpoint, the dispatcher groups due targets per tenant into one call. This is the biggest cost and scale lever.
- **Cursor store** (`poll:cursor:{source}:{target}`, holding the last `recordedAt` seen). It works for both API shapes:
  - **History API:** call with `from = cursor` and ingest every point newer than the cursor. Interval length does not reduce track resolution.
  - **Latest-only API:** ingest the point only if `recordedAt > cursor`.
  - In both cases, the same stale point returned again is dropped. **Getting a successful response is never mistaken for the device being alive.**
- **Rescheduling:** after every poll, `next_due_at = now + interval`, with the interval read from org settings. A small random jitter spreads the calls out.
- **What gets polled:**
  - **Roadcast** (built): every vehicle with a `gps_device_imei` in main's `vehicle_telemetry_meta`.
    - The scheduler leader ticks every `ROADCAST_POLL_INTERVAL_MS` (10 s, fixed for every org) and builds **one call per org**, with `{"input":{"deviceImeis":[…]}}`:
      - every tick, the IMEIs of the org's trucks on a trip, read from the **on-trip device registry** in Redis;
      - on the org's own sweep tick (one fixed slot of the 30 ticks in 5 min, by tenant-id hash), all of its IMEIs too, so idle trucks get a point every `ROADCAST_IDLE_INTERVAL_MS`.
    - **On-trip device registry:** `trk:ontrip-devices:{tenantId}` (hash IMEI → vehicleId) plus the org set `trk:ontrip-devices:tenants`.
      - The TripWatcher maintains it as trips start, end or get reassigned, in the same pipeline as the active-trip index. The IMEI comes from the load query itself (a join on `vehicle_telemetry_meta`), so there are no extra queries.
      - Removal is compare-and-delete in Lua, so a reassigned truck or a moved IMEI never drops another vehicle's entry.
      - The 10-min index rebuild rewrites it in one `MULTI`. That also catches an IMEI edited mid-trip.
    - **Cost per tick:** finding the on-trip IMEIs is 2 Redis round trips (`SMEMBERS` + pipelined `HGETALL`), with no SQL and nothing proportional to idle trucks. The idle sweep reads only that tick's slot of orgs from main (`gpsDeviceBindings({slot, slots})`), spreading both the SQL and the calls over 5 min. If that read fails, only the sweep is skipped; on-trip polling never waits on Postgres.
    - An org with nothing to fetch makes no call. More than 1000 IMEIs (`maxDeviceCap`) are split across calls.
    - Jobs are spread across the tick (BullMQ `delay`) rather than bursting. Each org's job id is fixed (`roadcast-{tenantId}-{n}`), so a slow org never builds a backlog or delays the others. The poller runs 4 calls in parallel.
    - A trip starting is picked up within ~15 s: the TripWatcher's 5 s poll, then the next 10 s tick.
    - `tracking_roadcast_api_calls_total{tenant}` counts the calls per org.
    - Cursor: Redis hash `trk:poll:cursor:roadcast` (IMEI → last published `gpsFixTimestamp`). The position time is `gpsFixTimestamp`, never the heartbeat `deviceTimestamp`.
    - No active trip: at most one point per `ROADCAST_IDLE_INTERVAL_MS` (5 min).
  - **SIM:** only during an active trip with consent, at the org's `simIntervalMin`. Consent is started at trip start and stopped at trip end.
  - **ULIP:** per active trip every 15 min. The token is refreshed every 30 min under a lock. An alert fires if the last successful poll was more than 24 h ago, to stay inside ULIP's 72 h retention.
- **Raw archive:** every provider response is buffered and written to S3 every 5 min as gzipped NDJSON.

## 4. Org-configurable tracking settings (org admin)

**API:** `GET` and `PUT /v1/org-settings/tracking`.
- Requires a new permission `tracking.settings.manage`. Add it to the main backend's `src/shared/constants/permissions.ts` and seed it to `org_admin`.
- Validated with zod.
- Every change is written to `audit_log`.

| Setting | Range | Default | Applied by |
|---|---|---|---|
| `sourcePriority` | A permutation of `roadcast`, `driver_app`, `sim` | `roadcast, driver_app, sim` | Waterfall selector (new trips) |
| Roadcast on-trip interval | — | **10 s, fixed** (env `ROADCAST_POLL_INTERVAL_MS`) | Not per org |
| Roadcast idle interval | — | **5 min, fixed** (env `ROADCAST_IDLE_INTERVAL_MS`) | Same |
| `simIntervalMin` | **10–20 min** | 20 | Same; also sent to Intugine on consent if their API needs it |
| Phone interval | — | **15 s, fixed** | Not configurable |

**No-signal thresholds are derived from the intervals, never hard-coded**, so changing an interval can't trigger false alerts:
- Phone: 5 min (20 missed points).
- Roadcast: today the INACT-GPS rule (60 min, 30 for tankers), measured on the device's `recordedAt`.
- SIM: `2 × simIntervalMin + 2 min`.

**When changes take effect:**
- **Interval** changes apply immediately to running trips; due times are recomputed.
- **Priority** changes apply only to **new** trips. Each trip keeps a `settings_snapshot`, so the active source isn't reshuffled in front of a live shipper.

**Propagation:** settings are cached in Redis as `org:{tid}:tracking-settings`. A `PUT` publishes `org_settings.changed` to invalidate the cache and reschedule polls.

**Cost hint in the UI:** show the estimated number of SIM and Roadcast API calls per month for the chosen intervals.

## 5. Waterfall (source selection)
- **Priority:** comes from the trip's `settings_snapshot.sourcePriority`.
- **Silence:** each source's silence is measured from its last **accepted** (post-cleaning) point.
  - The Redis key `src:{trip}:{source}:last_accepted` has a TTL equal to the derived threshold.
  - A key expiring means that source is silent.
- **Fallback:** when the active source goes silent, switch to the next live source in priority order. Write `trip_source_link` (`active_from`, `active_to`, `reason`) and `audit_log`, and emit `trip.source_switched`.
- **Recovery:** switching back to a higher-priority source needs **3 consecutive accepted points**, which prevents flapping.
- **No source at start:** keep evaluating until a first source appears.
- **All sources silent:** show the last ULIP crossing as a **static checkpoint** and flag the trip for ops. Speed and heading are never derived from ULIP.
- **Storage:** points from **every** source are stored, because they are needed for fallback and audit. The live map and track API show the **active** source's points. SIM points are drawn as separate low-accuracy checkpoints, never joined into the GPS polyline.

## 6. Data model (Postgres 16 + TimescaleDB + PostGIS)

All ids are UUIDs. Every row has `tenant_id`.

**Hypertables (bulk insert with raw `pg`, batched every 500 ms or 500 rows; not TypeORM `save`):**
- `location_points`
  - Columns: `(tenant_id, vehicle_id, trip_id?, source, source_ref, recorded_at, received_at, lat, lng, speed, heading, accuracy, flags jsonb)`
  - Chunks: 1 day.
  - Unique key: `(vehicle_id, source, recorded_at)`, which makes inserts idempotent (`ON CONFLICT DO NOTHING`).
  - Compression: `segmentby vehicle_id`, after 2 days.
- `toll_crossings`: unique on `(vehicle_id, plaza_id, crossed_at)`.
- `device_events`: whatever Roadcast exposes beyond ignition (carried in point `flags`), such as power cut.

**Retention (in migration 1; windows confirmed by product):**
- Continuous aggregate `location_points_1min`.
- Raw trip points from the active source: 90 days, then the aggregate only.
- Raw points from non-active sources and idle points (no trip): 7 days, then the aggregate.
- A scheduled prune job handles these per-row rules. `drop_chunks` cannot, because it drops whole chunks.

**Metadata tables (TypeORM entities):**
- Main's own tables (loads, vehicles, drivers, places) are read in place, never copied. Tracking-only additions: `trip_route_status`, `place_geocodes` (delivery points have no coordinates in main).
- Devices and providers:
  - ~~`devices`~~: not needed; the IMEI ↔ vehicle binding is main's `vehicle_telemetry_meta.gps_device_imei`
  - `sim_consents`: phone, trip, provider consent id, status
- Settings and source switching: `org_tracking_settings`, `trip_source_link`
- Location:
  - `vehicle_location_context`, `vehicle_location_events`
  - `geofences`, `geofence_events`
  - `boundary_{state,district,city}` (MultiPolygon 4326 with a GIST index), `boundary_dataset`
- Plumbing: `audit_log`, `outbox`, `inbox_dedup`, `share_links`

**Redis keys:**
- Vehicle and trip state:
  - `veh:{id}:latest`: the last accepted point
  - `veh:{id}:ctx`: the location context
  - `trip:{id}:active_source`
  - `drv:{id}:active_trip`
- Source silence: `src:{trip}:{source}:last_accepted`, with a TTL
- Polling: `poll:due` (ZSET) and `poll:cursor:*`
- Settings cache: `org:{tid}:tracking-settings`

## 7. Shared event contract (build first)

```ts
NormalizedPoint {
  eventId, tenantId, vehicleId, tripId?,
  source: 'driver_app' | 'roadcast' | 'sim',
  sourceRef,                 // driverId / device IMEI / consentId
  recordedAt, receivedAt,
  lat, lng, speed?, heading?, accuracy?,
  flags?: { isMock?, appState?, batteryPct?, lowAccuracy? }
}
```
- **Partition:** stream `points:{hash(vehicleId) % 16}`. Each partition is owned by one processor through a Redis lease, so each vehicle's points are processed in order.
- **Failures:** 5 failures send a point to `points:dlq`.
- **Retention:** `MAXLEN ~` sized for about 48 h, which allows replay.

## 8. Integration with the main backend

1. **Main backend → tracking:** no events. Tracking reads main's tables directly (shared database).
   - The TripWatcher (scheduler leader) polls `loads.updated_at` every few seconds into the Redis active-trip index, with a full rebuild on leader takeover and every 10 min.
   - A trip starts at `truck_assigned` and ends at `delivered` / `closed`.
2. **Tracking → main backend:** the stream `tracking.events` carries:
   - `trip.arrived_at_pickup`
   - `trip.departed_pickup`
   - `trip.arrived_at_delivery` (our own geofence, **not** Intugine's 6-hour auto-close)
   - `trip.no_signal`
   - `trip.source_switched`
   - The main backend uses these to set `atPlantAt`, `inTransitAt` and `reachedDeliveryPointAt` automatically. Manual `PATCH` stays as an audited override.
3. **Auth:**
   - Org and staff users: verify the JWT with the shared `JWT_SECRET`, check `purpose`, `portal`, the jti blocklist (read the main Redis key `access-token-blocklist:*`), tenant scoping, and `permissions[]`.
   - Driver sockets: `purpose='driver-access'`.
   - Public links: an opaque signed token issued by tracking, scoped to one trip, with an expiry.
   - Later, move to RS256 with JWKS so tracking no longer holds the signing secret.
4. **Main backend's `src/modules/tracking/` scaffold:** replace it with an HTTP gateway (the existing `*.gateway.ts` pattern) for any reads that go through the main API. The frontends call tracking REST and `/live` directly.

## 9. Roadmap (phases, deliverables, exit criteria)

Durations assume 1–2 backend developers. Phases 4, 5 and 8 depend on provider API answers (section 12) and can be reordered.

**Phase 0: Foundations (1 week)**
- Repo scaffold, conventions and docker-compose (Timescale+PostGIS, Redis, MinIO).
- pino logging, OpenTelemetry, `/metrics`, `/healthz` and `/readyz`. CI with lint, vitest and a migrations check.
- Dockerfile and the `ROLE` entrypoints.
- Exit: `ROLE=all` boots and CI is green.

**Phase 1: Schema, event contract, sync (1.5 weeks)**
- Hypertables, compression, aggregates and retention; metadata tables; the stream bus (partitioner, leased consumer, DLQ); the S3 archiver.
- ~~Main backend: outbox and relay. Tracking: `sync` consumer and read models.~~ Superseded: tracking reads main's tables directly (4a7c563).
- Exit: assigning a load creates a tracking trip within 5 s, and replaying the event is a no-op.

**Phase 2: Phone GPS over socket.io, end to end (2 weeks; the first live source)**
- `/driver` namespace with auth, `loc` and `loc:batch` with acks, guards, and `drv:{id}:active_trip` resolution.
- Processor steps: clean (accuracy over 50 m, mock location, implied speed over 150 km/h, future timestamps, **stationary jitter suppression**), motion state, distance. Bulk writer. Redis latest state.
- Exit:
  - 2,000 simulated sockets at 15 s each: ack p99 under 100 ms and stream lag under 2 s.
  - Kill a `realtime` pod: phones reconnect and flush their offline batches with no gaps and no duplicates.
  - A stationary phone adds 0 km.
- Result (2026-10-07, single `ROLE=all` process on a dev machine, plain Postgres, `scripts/simulate-phones.ts --phones 2000 --duration 600 --burst 0.2`):
  - 78,789 acks in 603 s (130.7/s). Ack latency: p50 2.1 ms, p95 4.2 ms, **p99 14.3 ms**, max 148 ms. No errors.
  - Burst: 400 phones offline for 60 s, then each flushed its queue as one `loc:batch` on reconnect.
  - 79,996 points acked, 79,996 stored in `location_points`: **no loss**.
  - Not measured yet: stream lag (the simulator only checks that stored ≥ acked within 30 s), the pod-kill test, and the stationary-phone distance test.

**Phase 3: Read API and live map (1.5 weeks)**
- REST endpoints:
  - `GET /v1/vehicles/:id/location`
  - `GET /v1/trips/:id/track?resolution=low|med|full`, simplified from the 1-minute aggregate for overviews, optionally as an encoded polyline
  - `GET /v1/vehicles/:id/timeline`
- `/live` namespace: rooms `tenant:`, `trip:` and `vehicle:`, the Redis adapter, and at most one push per vehicle every 5 s.
- Exit: the Loadsmart-V2-Frontend map shows a live marker and trip polyline from phone data.

**Phase 4: Pull engine + Roadcast GPS devices (replaces BlackRock BR05)**
- Built (2026-10-23): `modules/ingest-roadcast`, the `poller` role (BullMQ worker, one call per org) and the scheduler's `roadcast-dispatch` loop. The due ZSET and circuit breaker wait for Intugine, which is per consent and billed per call.
- Device ↔ vehicle binding, from `vehicle.telemetry_meta_changed` or a manual admin API.
- Polling around the clock, with separate trip and idle intervals.
- Roadcast API: `POST …/api/v2/rest/integrations/pull-positions-api`, header `X-API-KEY` (one global key), body `{"input":{"deviceImeis":["<imei>", …]}}` (up to `maxDeviceCap` 1000 per call; `{"input":{}}` would return the whole account), latest-only, UTC timestamps.
- Exit:
  - 2,000 bound vehicles are polled within their interval, with no provider 429 errors.
  - A latest-only response repeated with the same `recordedAt` creates no new row.
  - A Roadcast outage marks vehicles `stale` without an error cascade.

**Phase 5: SIM tracking pull via Intugine (1.5 weeks)**
- Consent lifecycle tied to the trip (start at trip start, stop at close), the poll job at `simIntervalMin`, and the normalizer. SIM points are marked low-accuracy and excluded from speed and heading.
- Billed-call metric.
- Exit:
  - A sandbox trip receives SIM points at the configured interval.
  - Consent stops when the trip closes, and no polls continue after it.

**Phase 6: Org settings + waterfall + trip lifecycle (2 weeks)**
- The `org-settings` API and appliers (section 4), and the main backend's permission seed.
- The waterfall from section 5, with derived thresholds and the 3-point switch-back.
- Trip close through our own delivery geofence, emitting the milestone events back to the main backend.
- Exit:
  - Property tests over every priority permutation, interval setting and on/off sequence pass with no flapping and correct `trip_source_link` intervals.
  - An interval change raises no false no-signal alert.
  - Load status advances automatically in the main app.

**Phase 7: Location resolver, PostGIS (1.5 weeks)**
- Boundary import: validate, `ST_MakeValid`, SRID 4326, GIST index, dataset version. Use an India state, district and town dataset licensed for commercial use.
- `LocationResolver` interface with a PostGIS implementation using `ST_Covers`.
- Triggered when the vehicle moves 500 m or 2 min pass. 3-point hysteresis. Writes `vehicle_location_events`, and the context goes into the `/live` payload.
- Customer geofences (loading and delivery points) produce entry and exit events.
- Exit: the Delhi → Dehradun replay produces exactly the expected transitions with no flapping.

**Phase 8: ULIP FASTag checkpoints (1 week)**
- ULIP adapter on the pull engine, token manager, and the toll-match step. Crossings appear on the trip timeline and serve as the last-resort checkpoint.

**Phase 9: ETA, delay and alerts (2 weeks)**
- The planned route comes from the Routes API **once per trip** and is cached. ETA is recomputed from remaining distance and rolling speed. The provider is called again at most every 15 min or when the vehicle deviates from the route.
- Delay against plan, overspeed, and long halts.
- Harsh driving is calculated only on dense GPS data (phone at 15 s, or Roadcast at 10 s).
- Alerts go through BullMQ to notifications.

**Phase 10: Public links, security, hardening (1.5 weeks)**
- Public share endpoint: cached for 10 s, rate-limited per IP and per token, behind a WAF.
- Encryption at rest. Write down the consent basis for each source under DPDP: device data is about the vehicle, while phone and SIM data are about the person.
- Load and chaos tests are in section 13. Write runbooks for DLQ replay and provider outages. Check that the retention jobs actually run.

## 10. Scaling design: horizontal paths and trigger metrics

| Component | Day 1 (≤ 2k vehicles) | Scale action | Trigger |
|---|---|---|---|
| Phone socket ingest | `realtime`, 2 pods, websocket-only | More pods. Then split `/driver` into its own `ROLE=ingest-ws`, separate from the viewer `/live`. At very large scale, move to MQTT (EMQX) | More than 10k sockets per pod, ack p99 over 200 ms, or event-loop lag over 50 ms |
| Live viewers | Same `realtime` pods, Redis adapter | Separate viewer pods, then Centrifugo | Viewer fan-out CPU or connection count |
| Pull engine | 1–2 `poller` instances | More workers. The **provider rate limit is the real ceiling**, so use bulk endpoints and longer idle intervals | Due-queue lag (`now − oldest due`) over 30 s, or 429 errors |
| Point stream | Redis Streams, 16 partitions | Up to 16 processors, then Kafka with the same key | Lag over 30 s sustained, Redis memory over 60%, or more than 20k vehicles |
| Processor | 2 | Up to 16; move the location resolver to its own worker | Lag or step p95 |
| Time series | Managed Postgres + Timescale (4 vCPU) | Bigger instance and read replica, then ScyllaDB behind `PointRepository` | Insert p95 over 50 ms, storage over 1 TB, or CPU over 70% |
| Redis | 1 managed instance with replica | Split into streams, cache and pub/sub instances, then Redis Cluster | Ops/s over 50k or memory pressure |
| Public links | Separate route, 10 s cache | CDN edge cache | Abuse or RPS spikes |

**Rules that keep every scale step a configuration change, not a rewrite:**
- Every store and provider sits behind an interface: `PointRepository`, `StreamBus`, `ProviderAdapter`, `LocationResolver`.
- Every step is idempotent.
- Partitioning by vehicle is consistent end to end.
- No in-process state that can't be rebuilt from Redis or Postgres.

## 11. Observability (from Phase 0)

**Metrics:**
- Points received and accepted per source.
- Connected driver sockets and reconnect rate.
- Socket ack latency.
- Poll due-queue lag, provider latency, error rate and 429s, circuit-breaker state.
- **Billed API calls per provider per org** (a cost signal).
- Stream lag per partition and DLQ depth.
- Insert latency and storage growth.
- Fleet-wide no-signal rate.
- ULIP token failures.
- DB replication lag.

**Alerts:** a no-signal spike across the fleet (most likely a provider outage), plus every lag and error metric above crossing its threshold.

## 12. Open items (blocking phase)
- **Roadcast API** (Phase 4, built; still to confirm):
  - the unit of `speed` (field names look Traccar-based, which reports knots; `ROADCAST_SPEED_UNIT` switches it)
  - the rate limit (one call per active org per 10 s: 50 orgs is 5 calls/s)
- **Intugine SIM API** (before Phase 5):
  - the pull endpoint's shape
  - latest-only vs history
  - whether the ping frequency is set per consent (within 10–20 min) and whether it can be changed mid-consent
  - billing per ping vs per call
  - the consent flow for the driver's phone number
- The "planned distance" figure used for SIM distance travelled: ours or Intugine's (before Phase 5).
- Retention windows (before Phase 1 migrations).
- Boundary dataset licence (before Phase 7).
- Market trucks (`sourceType=market`, free-text `vehicleNumber`) only have phone, SIM and ULIP. Decide how a tracking vehicle identity is created for them (before Phase 1).

## 13. Verification
- **Unit tests (vitest):**
  - each cleaning and processing step, including phone jitter and mock-location cases
  - cursor logic for both latest-only and history responses
  - waterfall property tests across priorities and intervals
  - resolver cases: boundary, outside, noise
- **Integration tests** (Testcontainers: Timescale, PostGIS, Redis): socket ingest, then stream, then processor, then DB; poll job, then stream, then DB, against a mocked provider; replay idempotency; DLQ.
- **End to end:** a simulator replays a Delhi → Dehradun trip through the phone socket, the mocked Roadcast and Intugine APIs, and ULIP. Assert:
  - the live marker on `/live`
  - the polyline API
  - city transitions
  - `trip_source_link` switches when the phone goes silent
  - the main backend load reaching `reached_delivery_point`
- **Load test** (k6 with its socket.io extension, plus mocked providers with realistic latency and 429s), 1 hour at 2× target:
  - 4,000 driver sockets at 15 s, including a burst where 20% reconnect at once with 200-point batches
  - 4,000 Roadcast devices on trips across orgs, one call per org every 10 s
  - Pass criteria: ack p99 under 100 ms, poll due-lag under 30 s, stream lag under 5 s, zero lost acked points.
